const { Redis } = require('@upstash/redis');
const kv = Redis.fromEnv();
const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Lightweight, Stripe-free endpoint so the storefront can poll live stock counts
// frequently without re-hitting the Stripe API on every poll. The client already
// knows which Redis keys it cares about -- it builds them the exact same way
// products.js / checkout.js do: `stock_${productId}_${metadataKey}` -- so this
// endpoint just does a single Redis MGET and hands the raw numbers back.
//
// STOCK_POLL_MAX_KEYS -- keep this comfortably ABOVE index.html's own
// STOCK_POLL_CHUNK_SIZE (pollLiveStock() there splits large catalogs into chunks of that
// size and sends them as parallel requests). This used to be a hard 300 with no chunking
// on the client side at all -- once the catalog grew past 300 tracked stock keys, EVERY
// poll request came back a flat 400 here, which silently broke live stock/Golden-Ticket
// updates catalog-wide (the client bailed out of the whole poll on any non-2xx response).
const STOCK_POLL_MAX_KEYS = 500;

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
        const resurrectionSessionId = req.body && req.body.resurrectionSessionId;

        // An empty keys array is always valid now, even with no resurrection session to look
        // up -- the Golden Ticket lookup below is unconditional, so a poll with nothing
        // stock-tracked to MGET still has real work to do (and a real answer to give back).
        if (keys.length > STOCK_POLL_MAX_KEYS) {
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

        // GOLDEN TICKET: piggybacked on this same already-polled endpoint (same reasoning as the
        // resurrection check below -- this project is already at Vercel Hobby's 12-function cap)
        // so every visitor's browser can notice a golden ticket appearing, moving to a different
        // product, or being claimed and cleared -- WITHOUT a dedicated Realtime subscription on
        // the high-traffic products table, which would broadcast every routine stock/price edit
        // to every connected tab. One indexed lookup (products_golden_ticket_idx), unconditional
        // (not gated behind a query param) since it's cheap and every poll already happens every
        // 10s regardless -- see pollLiveStock() in index.html for the client-side comparison
        // that decides whether this actually changed anything worth a re-render.
        const { data: goldenRow } = await supabaseAdmin.from('products').select('id').eq('is_golden_ticket', true).maybeSingle();
        responseBody.goldenTicketProductId = (goldenRow && goldenRow.id) || null;

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
