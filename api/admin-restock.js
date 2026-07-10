const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { notifyRestock } = require('./lib/notify');

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // Identify the caller from their own session token, same pattern as submit-review.js --
        // never trust a user id passed in the request body.
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'Not signed in.' });

        const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
        if (userErr || !userData || !userData.user) {
            return res.status(401).json({ error: 'Your session has expired -- please sign in again.' });
        }
        const userId = userData.user.id;

        // ADMIN GATE: this is the actual security boundary. The button only being visible to
        // admins on the frontend is UX -- anyone could still call this endpoint directly, so
        // this server-side check is what really stops them.
        const { data: profile } = await supabaseAdmin.from('profiles').select('is_admin').eq('id', userId).single();
        if (!profile || !profile.is_admin) {
            return res.status(403).json({ error: 'Not authorized.' });
        }

        const { productId, stripeMetaKey, newQuantity } = req.body;
        const qty = parseInt(newQuantity, 10);
        if (!productId || !stripeMetaKey || !Number.isInteger(qty) || qty < 0) {
            return res.status(400).json({ error: 'Missing or invalid product, variant key, or quantity.' });
        }

        // Same canonical key format used everywhere else (checkout.js, products.js, webhook.js)
        const redisKey = `stock_${productId}_${stripeMetaKey}`;

        const rawPrevious = await kv.get(redisKey);
        const previousStockLevel = parseInt(rawPrevious) || 0;

        await kv.set(redisKey, qty);

        // Keep Stripe's metadata as the cold-storage mirror, same as webhook.js already does
        // after a completed order -- so the Dashboard and products.js's lazy-init both stay in
        // sync with reality, not just Redis.
        const product = await stripe.products.retrieve(productId);
        await stripe.products.update(productId, {
            metadata: { ...product.metadata, [stripeMetaKey]: qty.toString() },
        });

        // Only a genuine 0-or-below -> positive crossing counts as a restock worth alerting
        // wishlisters about -- same rule the automatic cart-release path uses, so correcting a
        // typo (5 -> 6) or topping up an already-available item stays silent.
        if (previousStockLevel <= 0 && qty > 0) {
            const imageUrl = product.images && product.images.length > 0 ? product.images[0] : null;
            await notifyRestock(supabaseAdmin, productId, product.name, imageUrl);
        }

        res.status(200).json({ ok: true, previousStockLevel, newStockLevel: qty });
    } catch (error) {
        console.error('Admin restock error:', error);
        res.status(500).json({ error: error.message });
    }
}