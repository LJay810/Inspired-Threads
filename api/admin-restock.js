import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { requireAdmin } = require('../lib/require-admin');
const { notifyRestock } = require('../lib/notify');
const { syncVariantStockToStripe } = require('../lib/stripe-sync');
const { mirrorStockToCatalog } = require('../lib/catalog-stock');
const { maybeMoveToGraveyard } = require('../lib/graveyard');

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

        // Same canonical key format used everywhere else (checkout.js, products.js, webhook.js)
        const redisKey = `stock_${productId}_${stripeMetaKey}`;

        const rawPrevious = await kv.get(redisKey);
        const previousStockLevel = parseInt(rawPrevious) || 0;

        await kv.set(redisKey, qty);

        // Cold-storage mirror is now Supabase (product_variants for size/color keys, products.stock
        // for the plain "stock" key), replacing Stripe metadata's old role -- same reasoning as
        // before: keeps a persistent source in sync with Redis, not just live in memory.
        await mirrorStockToCatalog(productId, stripeMetaKey, qty);
        const { data: productRow } = await supabaseAdmin
            .from('products')
            .select('name, images, category_id, pre_graveyard_category_id, pre_graveyard_sub_category_id')
            .eq('id', productId).single();
        const productName = productRow && productRow.name;

        // GRAVEYARD: manually zeroing out a DTF design's stock moves it to the Graveyard too,
        // same as the checkout path in webhook.js -- no-op for non-DTF products (see
        // move_product_to_graveyard in sql/graveyard_resurrection_schema.sql).
        let restoredFromGraveyard = false;
        if (qty <= 0) {
            await maybeMoveToGraveyard(supabaseAdmin, productId);
        } else if (productRow && productRow.category_id === 'graveyard' && productRow.pre_graveyard_category_id) {
            // RESTORE FROM GRAVEYARD: a deliberate admin action (not the automatic resurrection
            // pre-order flow, which never touches stock/category -- see
            // sql/graveyard_no_auto_restock.sql). This is the moment real inventory actually
            // exists, so restore the design to whatever category it came from, with the real
            // count the admin just entered.
            const { error: restoreErr } = await supabaseAdmin
                .from('products')
                .update({
                    category_id: productRow.pre_graveyard_category_id,
                    sub_category_id: productRow.pre_graveyard_sub_category_id,
                    pre_graveyard_category_id: null,
                    pre_graveyard_sub_category_id: null,
                })
                .eq('id', productId);
            if (restoreErr) throw restoreErr;
            restoredFromGraveyard = true;
        }

        // Mirrors the Stripe Dashboard's product metadata too, purely for cosmetic parity --
        // never blocks the restock itself if Stripe is unreachable.
        syncVariantStockToStripe(productId, stripeMetaKey, qty).catch(err =>
            console.error('Stripe stock mirror failed (restock itself still succeeded):', err.message));

        // Only a genuine 0-or-below -> positive crossing counts as a restock worth alerting
        // wishlisters about -- same rule the automatic cart-release path uses, so correcting a
        // typo (5 -> 6) or topping up an already-available item stays silent.
        let didNotify = false;
        if (previousStockLevel <= 0 && qty > 0 && productRow) {
            const imageUrl = productRow.images && productRow.images.length > 0 ? productRow.images[0] : null;
            await notifyRestock(supabaseAdmin, productId, productName, imageUrl);
            didNotify = true;
        }

        // Log the action regardless of outcome above -- a failure here should never undo or
        // block the restock itself, just means this one action won't show in the activity feed.
        try {
            await supabaseAdmin.from('restock_log').insert({
                admin_user_id: auth.callerId,
                admin_label: adminLabel,
                product_id: productId,
                product_name: productName,
                stripe_meta_key: stripeMetaKey,
                previous_qty: previousStockLevel,
                new_qty: qty,
                notified: didNotify,
            });
        } catch (logErr) {
            console.error('Failed to write restock_log entry (restock itself still succeeded):', logErr.message);
        }

        res.status(200).json({ ok: true, previousStockLevel, newStockLevel: qty, restoredFromGraveyard });
    } catch (error) {
        console.error('Admin restock error:', error);
        res.status(500).json({ error: error.message });
    }
}