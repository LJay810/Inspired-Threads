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
        const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
        const resurrectionSessionId = req.body && req.body.resurrectionSessionId;

        // A resurrection-status-only check (see below) has nothing to MGET, so an empty keys
        // array is only invalid when there's also no resurrection session to look up.
        if (keys.length === 0 && !resurrectionSessionId) {
            return res.status(400).json({ error: 'Missing keys array' });
        }
        if (keys.length > 300) {
            return res.status(400).json({ error: 'Too many keys requested' });
        }
        if (!keys.every((k) => typeof k === 'string' && k.startsWith('stock_'))) {
            return res.status(400).json({ error: 'Invalid key format' });
        }

        const values = keys.length > 0 ? await kv.mget(...keys) : [];

        const stock = {};
        keys.forEach((key, i) => {
            const v = values[i];
            stock[key] = v === null || v === undefined ? null : parseInt(v);
        });

        const responseBody = { stock };

        // Riding along on this same already-polled endpoint (rather than a new serverless
        // function -- this project is already at Vercel Hobby's 12-function cap) so the buyer's
        // browser can pick up the "your Graveyard resurrection went through" flag webhook.js
        // stashed in Redis right after their Stripe redirect. Read-once: deleted immediately so
        // a later poll (or another tab) never replays the same "IT'S ALIVE" animation.
        if (typeof resurrectionSessionId === 'string' && resurrectionSessionId.length > 0) {
            const raw = await kv.get(`resurrection_success_${resurrectionSessionId}`);
            if (raw) {
                await kv.del(`resurrection_success_${resurrectionSessionId}`);
                try {
                    responseBody.resurrection = typeof raw === 'string' ? JSON.parse(raw) : raw;
                } catch (err) {
                    responseBody.resurrection = null;
                }
            }
        }

        // Small cache window so a burst of near-simultaneous tabs/polls doesn't
        // hammer Redis, while still feeling "live" to shoppers.
        res.setHeader('Cache-Control', 'public, max-age=5, stale-while-revalidate=15');
        res.status(200).json(responseBody);
    } catch (error) {
        console.error('Stock poll error:', error.message);
        res.status(500).json({ error: error.message });
    }
}
