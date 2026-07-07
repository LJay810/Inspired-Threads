const { Redis } = require('@upstash/redis');
const kv = Redis.fromEnv();

// Lightweight, Stripe-free endpoint so the storefront can poll live stock counts
// frequently without re-hitting the Stripe API on every poll. The client already
// knows which Redis keys it cares about -- it builds them the exact same way
// products.js / checkout.js do: `stock_${productId}_${metadataKey}` -- so this
// endpoint just does a single Redis MGET and hands the raw numbers back.
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const keys = req.body && req.body.keys;

        if (!Array.isArray(keys) || keys.length === 0) {
            return res.status(400).json({ error: 'Missing keys array' });
        }
        if (keys.length > 300) {
            return res.status(400).json({ error: 'Too many keys requested' });
        }
        if (!keys.every((k) => typeof k === 'string' && k.startsWith('stock_'))) {
            return res.status(400).json({ error: 'Invalid key format' });
        }

        const values = await kv.mget(...keys);

        const stock = {};
        keys.forEach((key, i) => {
            const v = values[i];
            stock[key] = v === null || v === undefined ? null : parseInt(v);
        });

        // Small cache window so a burst of near-simultaneous tabs/polls doesn't
        // hammer Redis, while still feeling "live" to shoppers.
        res.setHeader('Cache-Control', 'public, max-age=5, stale-while-revalidate=15');
        res.status(200).json({ stock });
    } catch (error) {
        console.error('Stock poll error:', error.message);
        res.status(500).json({ error: error.message });
    }
}
