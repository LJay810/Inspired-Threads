const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    const reservedKeys = []; // tracks successful Redis reservations for this request, so we can roll back
    let sessionCreated = false;

    try {
        const cartItems = req.body.items;
        const fulfillmentMethod = req.body.fulfillment;
        const lineItems = [];
        const sessionMetadata = { item_count: cartItems.length.toString() };

        for (let i = 0; i < cartItems.length; i++) {
            const item = cartItems[i];
            const price = await stripe.prices.retrieve(item.priceId, { expand: ['product'] });
            const product = price.product;
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

            // Store exact keys in session metadata so the webhook never has to guess/reconstruct them
            sessionMetadata[`Item_${i + 1}`] = item.name;
            sessionMetadata[`id_${i}`] = item.priceId;
            sessionMetadata[`prod_id_${i}`] = product.id;
            sessionMetadata[`stripe_key_${i}`] = stripeMetaKey;
            sessionMetadata[`redis_key_${i}`] = hasStockLimit ? redisKey : ''; // empty = untracked, webhook skips it
            sessionMetadata[`qty_${i}`] = item.quantity.toString();
        }

        sessionMetadata['Fulfillment_Method'] = fulfillmentMethod === 'shipping' ? 'Standard Shipping' : 'Local Pickup';

        const sessionConfig = {
            payment_method_types: ['card'],
            line_items: lineItems,
            mode: 'payment',
            allow_promotion_codes: true,
            metadata: sessionMetadata,
            payment_intent_data: { metadata: sessionMetadata },
            success_url: `${req.headers.origin}/?success=true`,
            cancel_url: `${req.headers.origin}/?canceled=true&session_id={CHECKOUT_SESSION_ID}`,
            billing_address_collection: 'required',
            // Stripe's hard floor is 30 minutes — this is enforced as a failsafe.
            // The actual abandonment window is tightened by the cron-expire job (see cron-expire.js).
            expires_at: Math.floor(Date.now() / 1000) + (30 * 60),
        };

        if (fulfillmentMethod === 'shipping' && cartItems.length > 0) {
            sessionConfig.shipping_options = [
                {
                    shipping_rate_data: {
                        type: 'fixed_amount',
                        fixed_amount: { amount: 1000, currency: 'usd' },
                        display_name: 'Standard Shipping',
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

        res.status(500).json({ error: error.message });
    }
}
