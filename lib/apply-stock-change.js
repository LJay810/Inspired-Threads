const { notifyRestock } = require('./notify');
const { maybeMoveToGraveyard } = require('./graveyard');
const { mirrorStockToCatalog } = require('./catalog-stock');
const { syncVariantStockToStripe } = require('./stripe-sync');

// Single source of truth for "a stock number just changed" -- everything that needs to happen as
// a result (Redis write, cold-storage mirror, Graveyard move/restore, Stripe metadata mirror,
// wishlist restock email, activity log) lives here exactly once, so every UI that can change stock
// (mini restock panel, admin.html's product form, admin.html's variant matrix) behaves identically
// instead of each reimplementing its own subset. Originally api/admin-restock.js's handler body.
async function applyStockChange(supabaseAdmin, kv, { productId, stripeMetaKey, newQuantity, adminUserId, adminLabel }) {
    const redisKey = `stock_${productId}_${stripeMetaKey}`;

    const rawPrevious = await kv.get(redisKey);
    const previousStockLevel = parseInt(rawPrevious) || 0;

    await kv.set(redisKey, newQuantity);

    // Cold-storage mirror is Supabase (product_variants for size/color keys, products.stock for
    // the plain "stock" key) -- keeps a persistent source in sync with Redis, not just live in memory.
    await mirrorStockToCatalog(productId, stripeMetaKey, newQuantity);

    const { data: productRow } = await supabaseAdmin
        .from('products')
        .select('name, images, category_id, pre_graveyard_category_id, pre_graveyard_sub_category_id')
        .eq('id', productId).single();
    const productName = productRow && productRow.name;

    // GRAVEYARD: zeroing out a DTF design's stock moves it to the Graveyard (no-op for non-DTF
    // products or products still in stock -- see move_product_to_graveyard in
    // sql/graveyard_resurrection_schema.sql). Setting a positive number on an already-graveyarded
    // product is a deliberate "restore from Graveyard" action -- the moment real inventory
    // actually exists again -- restoring it to whatever category it came from.
    let restoredFromGraveyard = false;
    if (newQuantity <= 0) {
        await maybeMoveToGraveyard(supabaseAdmin, productId);
    } else if (productRow && productRow.category_id === 'graveyard' && productRow.pre_graveyard_category_id) {
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

    // Mirrors the Stripe Dashboard's product metadata too, purely for cosmetic parity -- never
    // blocks the stock write itself if Stripe is unreachable.
    syncVariantStockToStripe(productId, stripeMetaKey, newQuantity).catch(err =>
        console.error('Stripe stock mirror failed (stock write itself still succeeded):', err.message));

    // Only a genuine 0-or-below -> positive crossing counts as a restock worth alerting
    // wishlisters about -- correcting a typo (5 -> 6) or topping up an already-available item
    // stays silent.
    let didNotify = false;
    if (previousStockLevel <= 0 && newQuantity > 0 && productRow) {
        const imageUrl = productRow.images && productRow.images.length > 0 ? productRow.images[0] : null;
        await notifyRestock(supabaseAdmin, productId, productName, imageUrl);
        didNotify = true;
    }

    // Log the action regardless of outcome above -- a failure here should never undo or block
    // the stock write itself, just means this one action won't show in the activity feed.
    try {
        await supabaseAdmin.from('restock_log').insert({
            admin_user_id: adminUserId,
            admin_label: adminLabel,
            product_id: productId,
            product_name: productName,
            stripe_meta_key: stripeMetaKey,
            previous_qty: previousStockLevel,
            new_qty: newQuantity,
            notified: didNotify,
        });
    } catch (logErr) {
        console.error('Failed to write restock_log entry (stock write itself still succeeded):', logErr.message);
    }

    return { previousStockLevel, newStockLevel: newQuantity, restoredFromGraveyard, productName };
}

module.exports = { applyStockChange };
