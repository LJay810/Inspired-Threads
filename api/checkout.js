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

            let product, hasVariants, stripeMetaKey, redisKey, hasStockLimit;

            if (dbProduct && dbProduct.published) {
                product = dbProduct;
                const { data: productCategory } = await supabaseAdmin
                    .from('categories').select('card_layout_type').eq('id', product.category_id).single();
                hasVariants = productCategory && productCategory.card_layout_type === 'variant-apparel';
                stripeMetaKey = hasVariants ? `stock_${item.size}_${item.color}` : 'stock';
                redisKey = `stock_${product.id}_${stripeMetaKey}`;
                hasStockLimit = hasVariants
                    ? product.product_variants.some(v => v.size === item.size && v.color === item.color)
                    : product.stock !== null;

                if (item.resurrection) {
                    // Graveyard "resurrect" pre-order (DTF only): buying something that currently
                    // shows 0 stock is the entire point, so skip the normal reservation check --
                    // these designs are made to order (no physical inventory sitting ready), so
                    // stock is deliberately never touched by this purchase at all (see
                    // resurrect_product() in sql/graveyard_no_auto_restock.sql). No natural stock
                    // cap applies here (unlike every other item), so quantity is clamped instead
                    // of trusted as-is, to guard against a malformed/absurd client-supplied value.
                    hasStockLimit = false;
                    item.quantity = Math.max(1, Math.min(50, parseInt(item.quantity, 10) || 1));
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

            subtotalCents += product.price_cents * item.quantity;

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

            lineItems.push({
                price: item.priceId,
                quantity: item.quantity,
                adjustable_quantity: { enabled: true, minimum: 1 },
            });

            // One packed key per item (not six) -- see lib/cart-metadata.js for why.
            sessionMetadata[`item_${i}`] = packCartItemMetadata(item, product, stripeMetaKey, redisKey, hasStockLimit);

            // Human-readable, for whoever's packing the order -- size/color only ever lived in
            // metadata (never as a real Stripe line item field), so without this, that detail
            // is technically still recoverable from item_N above but not readable at a glance.
            const variantLabel = hasVariants ? ` (${item.size}/${item.color})` : '';
            packSummary.push(`${item.quantity}x ${item.name}${variantLabel}`);
        }

        // One extra key total (not one per item), so this barely touches the 50-key budget the
        // packed format just fixed. Truncated defensively -- Stripe caps any single metadata
        // value at 500 characters, and an unusually large order could theoretically approach it.
        const summaryText = packSummary.join(', ');
        sessionMetadata['Order_Summary'] = summaryText.length > 490
            ? summaryText.slice(0, 487) + '...'
            : summaryText;

        sessionMetadata['Fulfillment_Method'] = fulfillmentMethod === 'shipping' ? 'Standard Shipping' : 'Local Pickup';
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
                    .select('tier_spend, grandfathered_tier, referred_by, referral_signup_discount_used, referral_reward_pending, order_count, spin_prize_type, spin_prize_pct, spin_prize_used')
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

        // DISCOUNT PRIORITY: referral rewards (both flavors are a flat 15%) outrank the tier
        // standing discount (max 10%, VIP), which outranks manual promo codes -- Stripe
        // Checkout Sessions only allow ONE `discounts` coupon per session, so at most one of
        // these actually applies. Whichever one gets used is reserved optimistically here
        // (same pattern as stock/VIP-credit above) and released back by webhook.js if this
        // session expires unpaid.
        let discountPct = perks.standingDiscountPct;
        let referralDiscountType = null; // 'reward' | 'signup' | null, stamped into metadata below

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
        const SPIN_PRIZE_LABELS = {
            pop_socket: 'Mystery Pop-Socket',
            custom_pen: 'Mystery Custom Pen',
            mystery_gift: 'Free Mystery Gift', // legacy -- no longer a roll outcome, still redeemable
            mystery_keychain: 'Mystery Keychain',
            mystery_sticky_notes: 'Mystery Sticky Notes',
            mystery_cup_wraps: '3x Mystery Cup-Wraps',
            mystery_tshirt: 'Mystery T-Shirt',
        };
        let spinPrizeClaimed = false;
        if (referralProfile && supabaseAdmin && referralProfile.spin_prize_type && !referralProfile.spin_prize_used) {
            if (referralProfile.spin_prize_type === 'percent') {
                if (!referralDiscountType) {
                    const subtotalDollars = subtotalCents / 100;
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

        // Stripe Checkout can't combine a pre-applied `discounts` coupon with customer-entered
        // `allow_promotion_codes` on the same session -- so whenever an automatic discount
        // (referral or standing) applies, manual promo-code entry is disabled for that one
        // checkout. Everyone else (Bronze/Silver with no referral reward/guests) keeps the
        // ability to enter a promo code as before.
        if (discountPct > 0) {
            const coupon = await ensureStandingDiscountCoupon(discountPct);
            sessionConfig.discounts = [{ coupon: coupon.id }];
        } else {
            sessionConfig.allow_promotion_codes = true;
        }

        if (fulfillmentMethod === 'shipping' && cartItems.length > 0) {
            const subtotalDollars = subtotalCents / 100;
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

        res.status(200).json({ id: session.id });
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

        res.status(500).json({ error: error.message });
    }
}