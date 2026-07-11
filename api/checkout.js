const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const { createClient } = require('@supabase/supabase-js');
const { perksForTier, tierForXp } = require('../lib/loyalty');
const { packCartItemMetadata } = require('../lib/cart-metadata');

// Service-role client: only used server-side, only ever to READ a shopper's own xp so we know
// which tier's perks to apply. Never exposed to the browser.
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
            const price = await stripe.prices.retrieve(item.priceId, { expand: ['product'] });
            const product = price.product;
            subtotalCents += (price.unit_amount || 0) * item.quantity;
            const hasVariants = product.metadata && product.metadata.hasVariants === 'true';

            // Exact Stripe metadata key: 'stock' for standard items, 'stock_Small_Black' style for variants
            const stripeMetaKey = hasVariants ? `stock_${item.size}_${item.color}` : 'stock';

            // Canonical Redis key, built the same way everywhere (checkout.js, products.js)
            const redisKey = `stock_${product.id}_${stripeMetaKey}`;

            // UNTRACKED GUARD: only touch Redis if this item actually has a stock field in Stripe.
            // Made-to-order / unlimited items (no stock_* metadata) are left alone entirely.
            const hasStockLimit = product.metadata && product.metadata[stripeMetaKey] !== undefined;

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
        // query (defaults to Bronze/no perks/no referral state for guests, logged-out
        // shoppers, or if this lookup fails for any reason -- an outage here should never be
        // able to block checkout).
        let perks = perksForTier('Bronze');
        let referralProfile = null;
        if (supabaseUserId && supabaseAdmin) {
            try {
                const { data: profile } = await supabaseAdmin
                    .from('profiles')
                    .select('xp, referred_by, referral_signup_discount_used, referral_reward_pending, order_count')
                    .eq('id', supabaseUserId)
                    .single();
                if (profile) {
                    perks = perksForTier(tierForXp(profile.xp || 0));
                    referralProfile = profile;
                }
            } catch (err) {
                console.warn('Perk/referral lookup failed, proceeding without them:', err.message);
            }
        }

        // Physical perk (Silver+): flagged in metadata so whoever packs the order sees it in
        // the Stripe Dashboard -- there's no fulfillment system in this codebase to automate it.
        if (perks.stickerPack) sessionMetadata['Include_Sticker_Pack'] = 'Yes';

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

        res.status(500).json({ error: error.message });
    }
}