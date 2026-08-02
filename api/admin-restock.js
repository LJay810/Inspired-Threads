import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { requireAdmin } = require('../lib/require-admin');
const { applyStockChange } = require('../lib/apply-stock-change');

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const auth = await requireAdmin(req);
        if (auth.error) return res.status(auth.status).json({ error: auth.error });
        const adminLabel = auth.username || auth.callerId;

        const { productId, stripeMetaKey, newQuantity } = req.body;
        const qty = parseInt(newQuantity, 10);
        if (!productId || !stripeMetaKey || !Number.isInteger(qty) || qty < 0) {
            return res.status(400).json({ error: 'Missing or invalid product, variant key, or quantity.' });
        }

        const { previousStockLevel, newStockLevel, restoredFromGraveyard } = await applyStockChange(supabaseAdmin, kv, {
            productId, stripeMetaKey, newQuantity: qty, adminUserId: auth.callerId, adminLabel,
        });

        res.status(200).json({ ok: true, previousStockLevel, newStockLevel, restoredFromGraveyard });
    } catch (error) {
        console.error('Admin restock error:', error);
        res.status(500).json({ error: error.message });
    }
}