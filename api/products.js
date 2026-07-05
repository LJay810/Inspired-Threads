const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const products = await stripe.products.list({
            active: true,
            limit: 100,
            expand: ['data.default_price'],
        }).autoPagingToArray({ limit: 1000 });

        const formattedProducts = await Promise.all(
            products
                .filter(product => product.default_price && product.default_price.unit_amount)
                .map(async (product) => {
                    let liveMetadata = { ...product.metadata };

                    // Only iterates keys that already exist in Stripe metadata. A fully open-ended
                    // (made-to-order) product with no stock_* fields simply has nothing to loop over here.
                    for (const key of Object.keys(liveMetadata)) {
                        if (key.startsWith('stock_') || key === 'stock') {
                            // Same canonical key format used in checkout.js
                            const redisKey = `stock_${product.id}_${key}`;

                            let liveStock = await kv.get(redisKey);

                            // Lazy init: first time this key is read, seed Redis from Stripe's
                            // metadata number so the two stay in sync automatically.
                            if (liveStock === null) {
                                liveStock = parseInt(product.metadata[key]);
                                await kv.set(redisKey, liveStock);
                            }

                            liveMetadata[key] = liveStock.toString();
                        }
                    }

                    return {
                        id: product.id,
                        name: product.name,
                        description: product.description,
                        images: product.images,
                        metadata: liveMetadata, // now reflects live Redis-backed counts
                        price: (product.default_price.unit_amount / 100).toFixed(2),
                        priceId: product.default_price.id
                    };
                })
        );

        res.status(200).json(formattedProducts);
    } catch (error) {
        console.error('Stripe API Error:', error.message);
        res.status(500).json({ error: error.message });
    }
}
