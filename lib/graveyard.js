// Moves a sold-out DTF product into the 'graveyard' category via the move_product_to_graveyard
// RPC (see sql/graveyard_resurrection_schema.sql for the actual guard logic -- non-DTF products,
// still-in-stock products, and already-graveyarded products are all safe no-ops there). Shared by
// api/webhook.js (checkout path) and api/admin-restock.js (manual admin restock path) so the
// behavior is identical no matter how a DTF product's stock reached zero.
async function maybeMoveToGraveyard(supabaseAdmin, productId) {
    if (!supabaseAdmin || !productId) return false;
    try {
        const { data, error } = await supabaseAdmin.rpc('move_product_to_graveyard', { p_product_id: productId });
        if (error) throw error;
        return data === true;
    } catch (err) {
        // Never let this block the stock-sync path that called it.
        console.error('maybeMoveToGraveyard failed for', productId, ':', err.message);
        return false;
    }
}

module.exports = { maybeMoveToGraveyard };
