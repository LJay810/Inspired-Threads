const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Writes a stock number into its Supabase cold-storage mirror -- product_variants for a
// 'stock_<Size>_<Color>' key, products.stock for the plain 'stock' key. Redis remains the live/
// atomic source; this mirror exists purely so a fresh page load or a Redis flush has something
// persistent to lazily re-seed from (same role Stripe metadata used to play). Shared by
// api/admin-restock.js (manual admin edits) and api/webhook.js (post-checkout sync).
async function mirrorStockToCatalog(productId, stripeMetaKey, qty) {
    const variantMatch = stripeMetaKey.match(/^stock_(.+)_(.+)$/);
    if (variantMatch) {
        const [, size, color] = variantMatch;
        const { error } = await supabaseAdmin
            .from('product_variants')
            .update({ stock: qty })
            .eq('product_id', productId).eq('size', size).eq('color', color);
        if (error) throw error;
    } else {
        const { error } = await supabaseAdmin.from('products').update({ stock: qty }).eq('id', productId);
        if (error) throw error;
    }
}

module.exports = { mirrorStockToCatalog };
