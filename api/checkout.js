const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const { createClient } = require('@supabase/supabase-js');
const { perksForTier, effectiveTierName } = require('../lib/loyalty');
const { packCartItemMetadata } = require('../lib/cart-metadata');

// Service-role client: reads a shopper's own tier_spend (to pick tier perks) AND is now also the
// catalog lookup for checkout -- product name/price/stock-tracking come from our own
// products/categories tables, not from Stripe, since Stripe is invisible payment plumbing now
// (see lib/stripe-sync.js). Never exposed to the browser.
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

// One reusable Stripe Coupon per standing-discount percentage (5% for Gold, 10% for VIP),
// looked up-or-created on first use so nothing needs to be pre-configured in the Stripe Dashboard.
async function ensureStandingDiscountCoupon(percentOff) {
    const id = `LOYALTY_STANDING_${percentOff}`;
    try {
        return await stripe.coupons.retrieve(id);
    } catch (err) {
        if (err.code !== 'resource_missing') throw err;
        return stripe.coupons.create({
            id,
            percent_off: percentOff,
            duration: 'once',
            name: `Loyalty ${percentOff}% Off`,
        });
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    const reservedKeys = []; // tracks successful Redis reservations for this request, so we can roll back
    let sessionCreated = false;
    // Hoisted out of the try block (rather than declared with const inside it) so the catch
    // block below can always safely read them for rollback purposes, even if the error is
    // thrown before they'd normally get assigned a real value.
    let sessionMetadata = {};
    let supabaseUserId = null;

    try {
        const cartItems = req.body.items;
        const fulfillmentMethod = req.body.fulfillment;
        supabaseUserId = req.body.supabaseUserId || null; // only present for logged-in shoppers
        const lineItems = [];
        sessionMetadata = { item_count: cartItems.length.toString() };
        let subtotalCents = 0;
        const packSummary = []; // human-readable, for the Stripe Dashboard -- see Order_Summary below
        const itemCatalogMeta = []; // parallel to cartItems/lineItems -- {categoryId, priceCents, stripeProductId} per index, used by BUY 3 GET 1 FREE below

        for (let i = 0; i < cartItems.length; i++) {
            const item = cartItems[i];

            // Catalog lookup is now Supabase, keyed by the Stripe price id the cart already
            // carries (unchanged from the shopper's perspective -- priceId still comes from
            // /api/products, which now sources it from products.stripe_price_id).
            const { data: dbProduct } = await supabaseAdmin
                .from('products')
                .select('*, product_variants(*)')
                .eq('stripe_price_id', item.priceId)
                .maybeSingle();

            let product, hasVariants, stripeMetaKey, redisKey, hasStockLimit, isThreadApparel;
            // GOLDEN TICKET: an admin flags exactly one product (is_golden_ticket, see
            // sql/golden_ticket_schema.sql) to secretly go 100% free for whoever buys it first.
            // "First" is decided here, atomically, via a Redis NX claim -- same reserve/release
            // idiom already used for referral rewards, spin prizes, and VIP shipping credits
            // elsewhere in this file. Only ever true for a real catalog product (never the
            // Stripe-fallback branch below -- that's for standalone products like TikTok Live
            // Claims, which were never migrated into this catalog and can't carry this flag).
            let goldenTicketWonThisItem = false;

            if (dbProduct && dbProduct.published) {
                product = dbProduct;
                const { data: productCategory } = await supabaseAdmin
                    .from('categories').select('card_layout_type, filter_group').eq('id', product.category_id).single();
                hasVariants = productCategory && productCategory.card_layout_type === 'variant-apparel';
                // Every garment category (T-shirts, Hoodies, Crewnecks, Tank Tops) shares this
                // filter_group -- checking it here instead of a hardcoded category-id list means
                // BUY 3 GET 1 FREE below automatically covers any current or future Thread
                // apparel category, not just T-shirts specifically.
                isThreadApparel = productCategory && productCategory.filter_group === 'thread';
                stripeMetaKey = hasVariants ? `stock_${item.size}_${item.color}` : 'stock';
                redisKey = `stock_${product.id}_${stripeMetaKey}`;
                hasStockLimit = hasVariants
                    ? product.product_variants.some(v => v.size === item.size && v.color === item.color)
                    : product.stock !== null;

                if (item.resurrection) {
                    if (product.category_id === 'graveyard') {
                        // Graveyard "resurrect" pre-order (DTF only): buying something that
                        // currently shows 0 stock is the entire point, so skip the normal
                        // reservation check -- these designs are made to order (no physical
                        // inventory sitting ready), so stock is deliberately never touched by
                        // this purchase at all (see resurrect_product() in
                        // sql/graveyard_no_auto_restock.sql). No natural stock cap applies here
                        // (unlike every other item), so quantity is clamped instead of trusted
                        // as-is, to guard against a malformed/absurd client-supplied value.
                        hasStockLimit = false;
                        item.quantity = Math.max(1, Math.min(50, parseInt(item.quantity, 10) || 1));
                    } else {
                        // The client claimed this was a resurrection pre-order, but the product
                        // isn't (or is no longer) actually in the Graveyard -- never trust this
                        // flag blindly, since it bypasses the stock check entirely. Ignore it and
                        // fall through to the normal stock-checked path above; also clear the
                        // flag itself so packCartItemMetadata below doesn't pack a resurrection
                        // marker for an item that was never actually one.
                        item.resurrection = false;
                    }
                }

                if (product.is_golden_ticket) {
                    try {
                        // 30-minute TTL matches this session's own expires_at below -- if the
                        // session goes unpaid, webhook.js's checkout.session.expired handler
                        // releases this same key (kv.del) well before the TTL would anyway, but
                        // the TTL is a safety net in case that release step itself never runs.
                        const claimKey = `golden_ticket_claim_${product.id}`;
                        goldenTicketWonThisItem = await kv.set(claimKey, '1', { nx: true, ex: 1800 });
                    } catch (err) {
                        // Never let a Redis hiccup here block a real checkout -- worst case, this
                        // one shopper just pays the normal price instead of winning it.
                        console.warn('Golden ticket claim check failed, proceeding at normal price:', err.message);
                    }
                    if (goldenTicketWonThisItem) {
                        // The free win is exactly ONE unit, regardless of whatever quantity was
                        // sitting in the cart -- and it never competes for BUY 3 GET 1 FREE
                        // eligibility (already free; double-dipping into that too would either
                        // give away a second free unit or corrupt that logic's own line-item
                        // index bookkeeping, see the isThreadApparel exclusion below).
                        item.quantity = 1;
                    }
                }
            } else {
                // FALLBACK: not in the admin-managed catalog -- e.g. the standalone TikTok Live
                // Claims product, which uses its own hardcoded Stripe Price IDs (see index.html)
                // and was deliberately left out of the catalog migration since it isn't a normal
                // shop product. Read straight from Stripe, same as this whole codebase did
                // before the catalog existed, so anything Stripe-only still checks out fine.
                let stripePrice;
                try {
                    stripePrice = await stripe.prices.retrieve(item.priceId, { expand: ['product'] });
                } catch (err) {
                    return res.status(400).json({ error: `"${item.name || 'An item'}" in your cart is no longer available.` });
                }
                const stripeProduct = stripePrice.product;
                if (!stripePrice.active || !stripeProduct || !stripeProduct.active) {
                    return res.status(400).json({ error: `"${item.name || 'An item'}" in your cart is no longer available.` });
                }
                product = { id: stripeProduct.id, name: stripeProduct.name, price_cents: stripePrice.unit_amount || 0 };
                hasVariants = stripeProduct.metadata && stripeProduct.metadata.hasVariants === 'true';
                stripeMetaKey = hasVariants ? `stock_${item.size}_${item.color}` : 'stock';
                redisKey = `stock_${stripeProduct.id}_${stripeMetaKey}`;
                hasStockLimit = stripeProduct.metadata && stripeProduct.metadata[stripeMetaKey] !== undefined;
            }

            // A golden ticket win contributes $0 toward the real subtotal -- this feeds
            // everything downstream that cares about actual money owed (free-shipping threshold,
            // loyalty/referral/spin discount value comparisons, BUY 3 GET 1 FREE's own totals).
            subtotalCents += goldenTicketWonThisItem ? 0 : product.price_cents * item.quantity;

            itemCatalogMeta[i] = {
                // Never BOGO-eligible once it's already free -- see the comment where
                // goldenTicketWonThisItem is set, just above.
                isThreadApparel: !!isThreadApparel && !goldenTicketWonThisItem,
                priceCents: product.price_cents,
                stripeProductId: (dbProduct && dbProduct.published) ? product.stripe_product_id : product.id,
            };

            if (hasStockLimit) {
                // Atomic check-and-decrement. Redis executes DECRBY as a single operation,
                // so two simultaneous requests can never both succeed on the last unit.
                const newStockLevel = await kv.decrby(redisKey, item.quantity);

                if (newStockLevel < 0) {
                    // Not enough stock: put this item's decrement back
                    await kv.incrby(redisKey, item.quantity);

                    // Roll back any earlier items in this same cart that already reserved successfully
                    for (const rollbackItem of reservedKeys) {
                        await kv.incrby(rollbackItem.key, rollbackItem.qty);
                    }

                    // Read the true current count so the customer (and the client-side cart) can be
                    // corrected to match reality instead of just being told "someone bought it."
                    const rawAvailable = await kv.get(redisKey);
                    const availableStock = Math.max(0, parseInt(rawAvailable) || 0);

                    return res.status(400).json({
                        error: availableStock > 0
                            ? `STOCK ALERT: Only ${availableStock} of "${product.name}" left in stock. We've updated your cart to match.`
                            : `STOCK ALERT: "${product.name}" just sold out. We've removed it from your cart.`,
                        stockAlert: true,
                        cartIndex: i,
                        productId: product.id,
                        productName: product.name,
                        availableStock
                    });
                }

                reservedKeys.push({ key: redisKey, qty: item.quantity });
            }

            if (goldenTicketWonThisItem) {
                // $0 override, referencing the SAME underlying Stripe product (so the receipt/
                // Dashboard still shows the real garment/product name) -- never adjustable by the
                // customer at Stripe's hosted page, or they could bump quantity for more free
                // units. Same technique BUY 3 GET 1 FREE uses below for its own free line(s).
                lineItems.push({
                    price_data: { currency: 'usd', product: product.stripe_product_id, unit_amount: 0 },
                    quantity: 1,
                    adjustable_quantity: { enabled: false },
                });
                sessionMetadata['golden_ticket_won'] = 'true';
                sessionMetadata['golden_ticket_product_id'] = product.id;
            } else {
                lineItems.push({
                    price: item.priceId,
                    quantity: item.quantity,
                    adjustable_quantity: { enabled: true, minimum: 1 },
                });
            }

            // One packed key per item (not six) -- see lib/cart-metadata.js for why.
            sessionMetadata[`item_${i}`] = packCartItemMetadata(item, product, stripeMetaKey, redisKey, hasStockLimit);

            // Human-readable, for whoever's packing the order -- size/color only ever lived in
            // metadata (never as a real Stripe line item field), so without this, that detail
            // is technically still recoverable from item_N above but not readable at a glance.
            const variantLabel = hasVariants ? ` (${item.size}/${item.color})` : '';
            const goldenLabel = goldenTicketWonThisItem ? ' [GOLDEN TICKET - FREE]' : '';
            packSummary.push(`${item.quantity}x ${item.name}${variantLabel}${goldenLabel}`);
        }

        // BUY 3, GET THE 4TH FREE -- automatic store promo (Mom's idea), deliberately NOT a
        // Stripe promo code: Stripe's coupon/promo-code system only ever does percent-off or
        // amount-off the whole order, never "every Nth qualifying item is free." It's also
        // deliberately NOT a dynamic per-session Stripe coupon -- Stripe allows only ONE
        // `discounts` entry per Checkout Session (the same limit that's the whole reason the
        // choose-your-own-discount system above exists), so a coupon-based BOGO would force a
        // customer to pick between this promo and their own loyalty/spin/promo-code discount.
        // Instead the free unit(s) are baked directly into the line items below, so this always
        // stacks with whatever else the customer has going on.
        //
        // Qualifies: any Thread apparel garment (T-Shirts, Hoodies, Crewnecks, Tank Tops -- any
        // category sharing the 'thread' filter_group, see isThreadApparel above) with a DTF
        // design attached. Attaching a design adds a *separate* "[ATTACHED PRINT] <name>" cart
        // line alongside the garment (see addToCart() in index.html) -- the garment's name there
        // is always "<garment name> (w/ <design name>)", which is the only signal available here
        // for "this garment has a design attached." A plain garment with no design doesn't qualify.
        {
            const comboUnits = []; // one entry per qualifying (garment+print) unit, expanded by quantity
            for (let i = 0; i < cartItems.length; i++) {
                const meta = itemCatalogMeta[i];
                if (!meta || !meta.isThreadApparel) continue;
                const match = /^.* \(w\/ (.+)\)$/.exec(cartItems[i].name || '');
                if (!match) continue;
                const printIdx = cartItems.findIndex(ci => ci.name === `[ATTACHED PRINT] ${match[1]}`);
                if (printIdx === -1) continue; // no matching print line -- shouldn't happen, but never guess
                const printMeta = itemCatalogMeta[printIdx];
                const unitPriceCents = meta.priceCents + (printMeta ? printMeta.priceCents : 0);
                for (let u = 0; u < cartItems[i].quantity; u++) {
                    comboUnits.push({ garmentIdx: i, printIdx, unitPriceCents });
                }
            }

            // One free combo per complete group of 4 (floor division -- 3 qualifying units gets
            // nothing, 4 gets 1 free, 8 gets 2, etc.), and it's always the CHEAPEST combo(s) that
            // go free -- standard BOGO practice (the customer keeps paying for their pricier
            // picks). Sorts a COPY so comboUnits' original order is untouched.
            const sortedUnits = [...comboUnits].sort((a, b) => a.unitPriceCents - b.unitPriceCents);
            const freeCount = Math.floor(sortedUnits.length / 4);
            const freeCountByGarmentIdx = {};
            for (let k = 0; k < freeCount; k++) {
                const fu = sortedUnits[k];
                freeCountByGarmentIdx[fu.garmentIdx] = (freeCountByGarmentIdx[fu.garmentIdx] || 0) + 1;
            }

            const freeGarmentIndexes = Object.keys(freeCountByGarmentIdx).map(Number);
            if (freeGarmentIndexes.length > 0) {
                let totalFreeCents = 0;
                let totalFreeUnits = 0;
                const freeUnitsByIdx = new Map(); // lineItems index -> total free quantity on that line

                for (const garmentIdx of freeGarmentIndexes) {
                    const freeCount = freeCountByGarmentIdx[garmentIdx];
                    const printIdx = comboUnits.find(cu => cu.garmentIdx === garmentIdx).printIdx;
                    const garmentMeta = itemCatalogMeta[garmentIdx];
                    const printMeta = itemCatalogMeta[printIdx];

                    freeUnitsByIdx.set(garmentIdx, (freeUnitsByIdx.get(garmentIdx) || 0) + freeCount);
                    freeUnitsByIdx.set(printIdx, (freeUnitsByIdx.get(printIdx) || 0) + freeCount);

                    totalFreeCents += freeCount * (garmentMeta.priceCents + printMeta.priceCents);
                    totalFreeUnits += freeCount;
                }

                // Peel the free quantity off each affected line item and add it back as its own
                // $0 line (referencing the SAME underlying Stripe product, so it still shows the
                // real garment/print name on the receipt) -- never adjustable by the customer at
                // Stripe's hosted page, or they could bump a $0 line's quantity for more free gear.
                const removedIndexes = new Set();
                const extraFreeLineItems = [];
                for (const [idx, freeQty] of freeUnitsByIdx) {
                    lineItems[idx].quantity -= freeQty;
                    if (lineItems[idx].quantity <= 0) removedIndexes.add(idx);
                    extraFreeLineItems.push({
                        price_data: { currency: 'usd', product: itemCatalogMeta[idx].stripeProductId, unit_amount: 0 },
                        quantity: freeQty,
                        adjustable_quantity: { enabled: false },
                    });
                }
                for (let i = lineItems.length - 1; i >= 0; i--) {
                    if (removedIndexes.has(i)) lineItems.splice(i, 1);
                }
                lineItems.push(...extraFreeLineItems);

                subtotalCents -= totalFreeCents; // keep free-shipping-threshold/discount math below honest
                sessionMetadata['Buy3Get1Free_Applied'] = `${totalFreeUnits} free item${totalFreeUnits > 1 ? 's' : ''} w/ design ($${(totalFreeCents / 100).toFixed(2)} value)`;
            }
        }

        // One extra key total (not one per item), so this barely touches the 50-key budget the
        // packed format just fixed. Truncated defensively -- Stripe caps any single metadata
        // value at 500 characters, and an unusually large order could theoretically approach it.
        const summaryText = packSummary.join(', ');
        sessionMetadata['Order_Summary'] = summaryText.length > 490
            ? summaryText.slice(0, 487) + '...'
            : summaryText;

        // 'shipping_deposit_standalone' -- the TikTok Live Claims "Shipping Deposit" button
        // (see buyShippingDepositNow() in index.html) -- is neither a real shipping order nor a
        // pickup; it deliberately isn't 'shipping' so the shipping_options block below never
        // stacks a real shipping fee on top of this flat $9 deposit, but it still deserves its
        // own label rather than showing up as a misleading "Local Pickup" in the Dashboard/orders.
        sessionMetadata['Fulfillment_Method'] = fulfillmentMethod === 'shipping' ? 'Standard Shipping'
            : fulfillmentMethod === 'shipping_deposit_standalone' ? 'N/A (Shipping Deposit Only)'
            : 'Local Pickup';
        if (supabaseUserId) sessionMetadata['supabase_user_id'] = supabaseUserId;

        // LOYALTY PERKS + REFERRALS: look up the shopper's tier and referral status from one
        // query (defaults to Crew Member/no perks/no referral state for guests, logged-out
        // shoppers, or if this lookup fails for any reason -- an outage here should never be
        // able to block checkout).
        let perks = perksForTier('Crew Member');
        let referralProfile = null;
        if (supabaseUserId && supabaseAdmin) {
            try {
                const { data: profile } = await supabaseAdmin
                    .from('profiles')
                    .select('tier_spend, grandfathered_tier, referred_by, referral_signup_discount_used, referral_reward_pending, order_count, spin_prize_type, spin_prize_pct, spin_prize_used, credit_balance')
                    .eq('id', supabaseUserId)
                    .single();
                if (profile) {
                    perks = perksForTier(effectiveTierName(profile.tier_spend || 0, profile.grandfathered_tier));
                    referralProfile = profile;
                }
            } catch (err) {
                console.warn('Perk/referral lookup failed, proceeding without them:', err.message);
            }
        }

        // Physical perk (Bronze+): flagged in metadata so whoever packs the order sees it in
        // the Stripe Dashboard -- there's no fulfillment system in this codebase to automate it.
        if (perks.freeGift) sessionMetadata['Include_Free_Gift'] = 'Yes';

        const sessionConfig = {
            payment_method_types: ['card'],
            line_items: lineItems,
            mode: 'payment',
            metadata: sessionMetadata,
            payment_intent_data: { metadata: sessionMetadata },
            success_url: `${req.headers.origin}/?success=true`,
            cancel_url: `${req.headers.origin}/?canceled=true&session_id={CHECKOUT_SESSION_ID}`,
            billing_address_collection: 'required',
            // Stripe's hard floor is 30 minutes — this is enforced as a failsafe.
            // The actual abandonment window is tightened by the cron-expire job (see cron-expire.js).
            expires_at: Math.floor(Date.now() / 1000) + (30 * 60),
        };

        // DISCOUNT SELECTION: Stripe Checkout Sessions only allow ONE `discounts` coupon per
        // session, so at most one of referral/spin/crew-cash/standing ever actually applies.
        // 'auto' (the default, and the only mode that existed before this) picks the best-value
        // one automatically via the priority cascade below. An explicit discountChoice instead
        // lets the shopper pick which single one they want -- most notably including "none," so
        // a shopper with an unused spin-wheel prize or standing discount can still decline it in
        // favor of entering their own manual promo code, which Stripe can't combine with a
        // pre-applied coupon. Whichever one gets used is reserved optimistically here (same
        // pattern as stock/VIP-credit above) and released back by webhook.js if this session
        // expires unpaid -- that release logic keys off the sessionMetadata fields set below, so
        // it works identically regardless of which branch set them.
        const discountChoice = req.body.discountChoice || 'auto';

        const SPIN_PRIZE_LABELS = {
            pop_socket: 'Mystery Pop-Socket',
            custom_pen: 'Mystery Custom Pen',
            mystery_gift: 'Free Mystery Gift', // legacy -- no longer a roll outcome, still redeemable
            mystery_keychain: 'Mystery Keychain',
            mystery_sticky_notes: 'Mystery Sticky Notes',
            mystery_cup_wraps: '3x Mystery Cup-Wraps',
            mystery_tshirt: 'Mystery T-Shirt',
        };
        const subtotalDollars = subtotalCents / 100;

        let discountPct = perks.standingDiscountPct;
        let referralDiscountType = null; // 'reward' | 'signup' | null, stamped into metadata below
        let spinPrizeClaimed = false;
        // Distinct from spinPrizeClaimed below: only true when the percent branch actually wins
        // the discount slot. A physical prize (pop socket, pen, etc.) also sets spinPrizeClaimed,
        // but never touches discountPct or the slot at all -- Crew Cash should still be free to
        // apply alongside a physical prize, just not alongside a percent one.
        let spinDiscountApplied = false;
        let crewCashUsed = 0;

        if (discountChoice === 'auto') {
            // Referral rewards (both flavors are a flat 15%) outrank the tier standing discount
            // (max 10%, VIP), which outranks manual promo codes.
            if (referralProfile && supabaseAdmin) {
                try {
                    if (referralProfile.referral_reward_pending > 0) {
                        const { data: reserved } = await supabaseAdmin.rpc('reserve_referral_reward', {
                            p_user_id: supabaseUserId,
                        });
                        if (reserved) {
                            discountPct = 15;
                            referralDiscountType = 'reward';
                        }
                    }
                    if (!referralDiscountType
                        && referralProfile.referred_by
                        && !referralProfile.referral_signup_discount_used
                        && referralProfile.order_count === 0) {
                        const { data: reserved } = await supabaseAdmin.rpc('reserve_referee_discount', {
                            p_user_id: supabaseUserId,
                        });
                        if (reserved) {
                            discountPct = 15;
                            referralDiscountType = 'signup';
                        }
                    }
                } catch (err) {
                    console.warn('Referral discount lookup failed, falling back to tier discount:', err.message);
                }
            }
            if (referralDiscountType) sessionMetadata['referral_discount_type'] = referralDiscountType;

            // SPIN-WHEEL PRIZE: two different kinds, handled differently.
            //   - Percent-off ('percent'): LEGACY ONLY as of the six-physical-prize wheel redesign
            //     -- claim_spin_prize() (see sql/spin_wheel.sql) no longer hands these out to new
            //     spins, but anyone who already won one under the old odds keeps a fully-working
            //     prize, so this branch stays. Competes for Stripe's single discounts-per-session
            //     slot, same as the referral/tier discounts above. Compared by actual dollar value
            //     on THIS cart rather than raw percent-vs-percent -- the old raw comparison meant a
            //     Gold member's 5%-off prize could never beat their own already-5% standing
            //     discount (5 > 5 is false), silently making the "win" worthless for exactly the
            //     members most likely to have it. That redundancy is the whole reason the wheel no
            //     longer offers percent-off prizes at all; this fix just makes the comparison honest
            //     for whoever's still holding one from before.
            //   - Physical prize (all six current prizes, plus legacy 'mystery_gift'): doesn't touch
            //     pricing or that discount slot at all -- just flags the order for whoever packs it,
            //     same idea as Include_Free_Gift below, so it applies independently of whatever
            //     discount (if any) is also on this order.
            // Same reserve-now/release-on-expiry pattern as the referral signup discount above,
            // reused for both kinds via reserve_spin_prize/release_spin_prize.
            if (referralProfile && supabaseAdmin && referralProfile.spin_prize_type && !referralProfile.spin_prize_used) {
                if (referralProfile.spin_prize_type === 'percent') {
                    if (!referralDiscountType) {
                        const standingValueDollars = subtotalDollars * (discountPct / 100);
                        const spinValueDollars = subtotalDollars * (referralProfile.spin_prize_pct / 100);
                        if (spinValueDollars > standingValueDollars) {
                            try {
                                const { data: reserved } = await supabaseAdmin.rpc('reserve_spin_prize', {
                                    p_user_id: supabaseUserId,
                                });
                                if (reserved) {
                                    discountPct = referralProfile.spin_prize_pct;
                                    spinPrizeClaimed = true;
                                    spinDiscountApplied = true;
                                }
                            } catch (err) {
                                console.warn('Spin prize reservation failed, proceeding without it:', err.message);
                            }
                        }
                    }
                } else {
                    try {
                        const { data: reserved } = await supabaseAdmin.rpc('reserve_spin_prize', {
                            p_user_id: supabaseUserId,
                        });
                        if (reserved) {
                            spinPrizeClaimed = true;
                            sessionMetadata['Include_Spin_Prize'] = SPIN_PRIZE_LABELS[referralProfile.spin_prize_type] || referralProfile.spin_prize_type;
                        }
                    } catch (err) {
                        console.warn('Spin prize reservation failed, proceeding without it:', err.message);
                    }
                }
            }
            if (spinPrizeClaimed) sessionMetadata['spin_prize_used'] = 'true';

            // CREW CASH: the shopper's own stored balance (manually granted by an admin via
            // Customer Lookup), spendable like a gift card. It's a fixed dollar amount, not a
            // percentage, so it can't just stack on top of a percent_off coupon -- same single
            // discounts-per-session slot as everything above. Gated on !referralDiscountType &&
            // !spinDiscountApplied rather than a value comparison against those two specifically
            // (unlike the plain tier standing discount, which is compared by value): a referral
            // reward/signup discount and a spin percent prize were already RESERVED above (their
            // RPCs already ran and consumed/marked-used the reward) by the time this runs, so if
            // Crew Cash won by value and took the discount slot instead, that already-committed
            // reservation would be silently burned with the reward never actually applied to any
            // order. The plain standing discount never consumes anything to "earn" it, so
            // overriding that one by value is always safe -- and a physical spin prize
            // (spinPrizeClaimed but NOT spinDiscountApplied) never touches this slot at all, so
            // Crew Cash can still apply right alongside one of those.
            if (!referralDiscountType && !spinDiscountApplied && referralProfile && supabaseAdmin) {
                const creditBalance = parseFloat(referralProfile.credit_balance) || 0;
                if (creditBalance > 0) {
                    const currentDiscountValueDollars = subtotalDollars * (discountPct / 100);
                    const creditValueDollars = Math.min(creditBalance, subtotalDollars);
                    if (creditValueDollars > currentDiscountValueDollars) {
                        try {
                            const { data: applied } = await supabaseAdmin.rpc('use_crew_cash', {
                                p_user_id: supabaseUserId,
                                p_amount: creditValueDollars,
                            });
                            if (applied) {
                                crewCashUsed = creditValueDollars;
                                sessionMetadata['crew_cash_used'] = crewCashUsed.toFixed(2);
                            }
                        } catch (err) {
                            console.warn('Crew Cash reservation failed, proceeding without it:', err.message);
                        }
                    }
                }
            }
        } else {
            // EXPLICIT CHOICE: attempt ONLY the one discount-slot item the shopper actually
            // picked, instead of the value-comparison cascade above. Never trust discountChoice
            // blindly, though -- eligibility is re-checked here against the same server-side
            // profile data (never the client's say-so), and the RPCs themselves are the same
            // ones the auto path uses, so a stale/ineligible choice (e.g. a reward that got used
            // in another tab a moment ago) just safely no-ops rather than granting anything.
            if (referralProfile && supabaseAdmin) {
                if (discountChoice === 'referral_reward' && referralProfile.referral_reward_pending > 0) {
                    try {
                        const { data: reserved } = await supabaseAdmin.rpc('reserve_referral_reward', {
                            p_user_id: supabaseUserId,
                        });
                        if (reserved) {
                            discountPct = 15;
                            referralDiscountType = 'reward';
                        }
                    } catch (err) {
                        console.warn('Referral reward reservation failed, falling back to tier discount:', err.message);
                    }
                } else if (discountChoice === 'referral_signup'
                    && referralProfile.referred_by
                    && !referralProfile.referral_signup_discount_used
                    && referralProfile.order_count === 0) {
                    try {
                        const { data: reserved } = await supabaseAdmin.rpc('reserve_referee_discount', {
                            p_user_id: supabaseUserId,
                        });
                        if (reserved) {
                            discountPct = 15;
                            referralDiscountType = 'signup';
                        }
                    } catch (err) {
                        console.warn('Referral signup discount reservation failed, falling back to tier discount:', err.message);
                    }
                } else if (discountChoice === 'spin_percent'
                    && referralProfile.spin_prize_type === 'percent'
                    && !referralProfile.spin_prize_used) {
                    try {
                        const { data: reserved } = await supabaseAdmin.rpc('reserve_spin_prize', {
                            p_user_id: supabaseUserId,
                        });
                        if (reserved) {
                            discountPct = referralProfile.spin_prize_pct;
                            spinPrizeClaimed = true;
                            spinDiscountApplied = true;
                        }
                    } catch (err) {
                        console.warn('Spin prize reservation failed, falling back to tier discount:', err.message);
                    }
                } else if (discountChoice === 'crew_cash') {
                    const creditBalance = parseFloat(referralProfile.credit_balance) || 0;
                    if (creditBalance > 0) {
                        const creditValueDollars = Math.min(creditBalance, subtotalDollars);
                        try {
                            const { data: applied } = await supabaseAdmin.rpc('use_crew_cash', {
                                p_user_id: supabaseUserId,
                                p_amount: creditValueDollars,
                            });
                            if (applied) {
                                crewCashUsed = creditValueDollars;
                                sessionMetadata['crew_cash_used'] = crewCashUsed.toFixed(2);
                            }
                        } catch (err) {
                            console.warn('Crew Cash reservation failed, proceeding without it:', err.message);
                        }
                    }
                } else if (discountChoice === 'none') {
                    // Shopper explicitly declined every automatic discount -- e.g. to use their
                    // own manual promo code instead, which Stripe can't combine with a pre-
                    // applied coupon. Falls through with discountPct forced to 0 below.
                    discountPct = 0;
                }
                // 'standing' (or an unrecognized/stale value) needs no action here -- discountPct
                // already defaults to perks.standingDiscountPct above, and it's never "consumed,"
                // so there's nothing to reserve.

                if (referralDiscountType) sessionMetadata['referral_discount_type'] = referralDiscountType;
                if (spinPrizeClaimed) sessionMetadata['spin_prize_used'] = 'true';
            }

            // PHYSICAL spin prize (non-percent) never competes for the discount slot, so it's
            // always handled here regardless of which discount (if any) was just chosen above --
            // same as the auto path's own physical-prize branch.
            if (referralProfile && supabaseAdmin && referralProfile.spin_prize_type
                && referralProfile.spin_prize_type !== 'percent' && !referralProfile.spin_prize_used) {
                try {
                    const { data: reserved } = await supabaseAdmin.rpc('reserve_spin_prize', {
                        p_user_id: supabaseUserId,
                    });
                    if (reserved) {
                        sessionMetadata['Include_Spin_Prize'] = SPIN_PRIZE_LABELS[referralProfile.spin_prize_type] || referralProfile.spin_prize_type;
                        sessionMetadata['spin_prize_used'] = 'true';
                    }
                } catch (err) {
                    console.warn('Spin prize reservation failed, proceeding without it:', err.message);
                }
            }
        }

        // Stripe Checkout can't combine a pre-applied `discounts` coupon with customer-entered
        // `allow_promotion_codes` on the same session -- so whenever an automatic discount
        // (Crew Cash, referral, standing, or spin) applies, manual promo-code entry is disabled
        // for that one checkout. Everyone else (Bronze/Silver with no referral reward/guests, or
        // anyone who explicitly chose "none") keeps the ability to enter a promo code as before.
        if (crewCashUsed > 0) {
            // Unlike the standing-discount coupons, this amount is unique to this shopper's
            // balance and this cart -- created fresh each time rather than looked up/reused.
            const creditCoupon = await stripe.coupons.create({
                amount_off: Math.round(crewCashUsed * 100),
                currency: 'usd',
                duration: 'once',
                name: 'Crew Cash',
                max_redemptions: 1,
            });
            sessionConfig.discounts = [{ coupon: creditCoupon.id }];
        } else if (discountPct > 0) {
            const coupon = await ensureStandingDiscountCoupon(discountPct);
            sessionConfig.discounts = [{ coupon: coupon.id }];
        } else {
            sessionConfig.allow_promotion_codes = true;
        }

        if (fulfillmentMethod === 'shipping' && cartItems.length > 0) {
            const qualifiesForFreeShipping = perks.freeShippingMin !== null && subtotalDollars >= perks.freeShippingMin;

            let shippingFeeCents = 900;
            let shippingLabel = 'Standard Shipping';

            if (qualifiesForFreeShipping) {
                shippingFeeCents = 0;
                shippingLabel = 'Standard Shipping (Free — Loyalty Perk)';
            } else if (perks.vipShippingCredit && supabaseUserId && supabaseAdmin) {
                // VIP's $3.50-off perk, capped at N uses/calendar month. Reserved optimistically
                // here (same pattern as stock reservation above) so two near-simultaneous
                // checkouts can't both claim the same monthly use; if this session later expires
                // unpaid, webhook.js's checkout.session.expired handler releases it back.
                try {
                    const yearMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
                    const { data: creditApplied } = await supabaseAdmin.rpc('use_vip_shipping_credit', {
                        p_user_id: supabaseUserId,
                        p_year_month: yearMonth,
                    });
                    if (creditApplied) {
                        shippingFeeCents = Math.max(0, 900 - Math.round(perks.vipShippingCredit.amount * 100));
                        shippingLabel = `Standard Shipping (−$${perks.vipShippingCredit.amount.toFixed(2)} VIP Credit)`;
                        sessionMetadata['vip_credit_used'] = 'true';
                        sessionMetadata['vip_credit_month'] = yearMonth;
                    }
                } catch (err) {
                    console.warn('VIP shipping credit lookup failed, charging standard shipping:', err.message);
                }
            }

            sessionConfig.shipping_options = [
                {
                    shipping_rate_data: {
                        type: 'fixed_amount',
                        fixed_amount: { amount: shippingFeeCents, currency: 'usd' },
                        display_name: shippingLabel,
                        delivery_estimate: {
                            minimum: { unit: 'business_day', value: 5 },
                            maximum: { unit: 'business_day', value: 7 },
                        },
                    },
                },
            ];
            sessionConfig.shipping_address_collection = { allowed_countries: ['US'] };
        }

        const session = await stripe.checkout.sessions.create(sessionConfig);
        sessionCreated = true;

        // url (not just id) so the browser can do a plain top-level redirect instead of routing
        // through stripe.js's redirectToCheckout -- the plain redirect is what iOS's standalone
        // PWA scope-breakout (navigating an installed home-screen app to an external origin)
        // handles most reliably.
        res.status(200).json({ id: session.id, url: session.url });
    } catch (error) {
        console.error(error);

        // If Stripe's own API call failed (network blip, rate limit, bad param) AFTER we already
        // reserved stock in Redis, we must give it back — otherwise it's lost forever with no
        // session to ever expire and trigger a release.
        if (!sessionCreated && reservedKeys.length > 0) {
            for (const rollbackItem of reservedKeys) {
                await kv.incrby(rollbackItem.key, rollbackItem.qty);
            }
        }

        // Same idea for a reserved-but-unused VIP shipping credit.
        if (!sessionCreated && sessionMetadata['vip_credit_used'] === 'true' && supabaseAdmin) {
            await supabaseAdmin.rpc('release_vip_shipping_credit', {
                p_user_id: supabaseUserId,
                p_year_month: sessionMetadata['vip_credit_month'],
            });
        }

        // And for a reserved-but-unused referral discount.
        if (!sessionCreated && sessionMetadata['referral_discount_type'] && supabaseAdmin) {
            const rpcName = sessionMetadata['referral_discount_type'] === 'reward'
                ? 'release_referral_reward'
                : 'release_referee_discount';
            await supabaseAdmin.rpc(rpcName, { p_user_id: supabaseUserId });
        }

        // And for a reserved-but-unused spin-wheel prize.
        if (!sessionCreated && sessionMetadata['spin_prize_used'] === 'true' && supabaseAdmin) {
            await supabaseAdmin.rpc('release_spin_prize', { p_user_id: supabaseUserId });
        }

        // And for a reserved-but-unused Crew Cash amount.
        if (!sessionCreated && sessionMetadata['crew_cash_used'] && supabaseAdmin) {
            await supabaseAdmin.rpc('release_crew_cash', {
                p_user_id: supabaseUserId,
                p_amount: parseFloat(sessionMetadata['crew_cash_used']),
            });
        }

        // And for a reserved-but-unused Golden Ticket claim.
        if (!sessionCreated && sessionMetadata['golden_ticket_won'] === 'true') {
            await kv.del(`golden_ticket_claim_${sessionMetadata['golden_ticket_product_id']}`);
        }

        res.status(500).json({ error: error.message });
    }
}