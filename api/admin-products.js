const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { requireAdmin } = require('../lib/require-admin');
const { syncProductToStripe, archiveProductInStripe } = require('../lib/stripe-sync');

// Variants payload shape from admin.html's product form: [{ size, color, color_image_url, stock }, ...]
async function replaceVariants(productId, variants) {
    if (!Array.isArray(variants)) return;
    const { error: delErr } = await supabaseAdmin.from('product_variants').delete().eq('product_id', productId);
    if (delErr) throw delErr;
    if (variants.length === 0) return;
    const rows = variants.map(v => ({
        product_id: productId,
        size: v.size,
        color: v.color,
        color_image_url: v.color_image_url || null,
        stock: Number.isInteger(v.stock) ? v.stock : (parseInt(v.stock, 10) || 0),
    }));
    const { error: insErr } = await supabaseAdmin.from('product_variants').insert(rows);
    if (insErr) throw insErr;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const auth = await requireAdmin(req);
        if (auth.error) return res.status(auth.status).json({ error: auth.error });

        const { action } = req.body;

        if (action === 'list') {
            const { category_id, search, published } = req.body;
            let query = supabaseAdmin.from('products').select('*, product_variants(*)').order('sort_order', { ascending: true });
            if (category_id) query = query.eq('category_id', category_id);
            if (published !== undefined) query = query.eq('published', !!published);
            if (search) query = query.ilike('name', `%${search}%`);
            const { data, error } = await query;
            if (error) throw error;
            return res.status(200).json({ products: data || [] });
        }

        if (action === 'create') {
            const { name, description, category_id, price_dollars, images, dtf_placement, sub_category_id, stock, variants, extra_metadata, sort_order, published } = req.body;
            if (!name || !category_id || price_dollars === undefined) {
                return res.status(400).json({ error: 'Missing name, category_id, or price_dollars.' });
            }
            const priceCents = Math.round(parseFloat(price_dollars) * 100);
            if (!Number.isInteger(priceCents) || priceCents <= 0) {
                return res.status(400).json({ error: 'Invalid price.' });
            }

            const { data: category, error: catErr } = await supabaseAdmin.from('categories').select('*').eq('id', category_id).single();
            if (catErr || !category) return res.status(400).json({ error: 'Unknown category_id.' });

            const { data: product, error: insErr } = await supabaseAdmin.from('products').insert({
                name,
                description: description || null,
                category_id,
                images: Array.isArray(images) ? images : [],
                price_cents: priceCents,
                dtf_placement: dtf_placement || null,
                sub_category_id: sub_category_id || null,
                stock: category.card_layout_type === 'variant-apparel' ? null : (stock !== undefined && stock !== null ? parseInt(stock, 10) : null),
                extra_metadata: extra_metadata && typeof extra_metadata === 'object' ? extra_metadata : {},
                published: published !== undefined ? !!published : true,
                ...(Number.isInteger(sort_order) ? { sort_order } : {}),
            }).select().single();
            if (insErr) throw insErr;

            if (category.card_layout_type === 'variant-apparel') {
                await replaceVariants(product.id, variants || []);
            }

            const syncResult = await syncProductToStripe(product);
            return res.status(200).json({ product, sync: syncResult });
        }

        if (action === 'update') {
            const { id, name, description, category_id, price_dollars, images, dtf_placement, sub_category_id, stock, variants, published, extra_metadata, sort_order } = req.body;
            if (!id) return res.status(400).json({ error: 'Missing id.' });

            const { data: existing, error: fetchErr } = await supabaseAdmin.from('products').select('*').eq('id', id).single();
            if (fetchErr || !existing) return res.status(404).json({ error: 'Product not found.' });

            const updateFields = {};
            if (name !== undefined) updateFields.name = name;
            if (description !== undefined) updateFields.description = description || null;
            if (category_id !== undefined) updateFields.category_id = category_id;
            if (images !== undefined) updateFields.images = Array.isArray(images) ? images : [];
            if (dtf_placement !== undefined) updateFields.dtf_placement = dtf_placement || null;
            if (sub_category_id !== undefined) updateFields.sub_category_id = sub_category_id || null;
            if (stock !== undefined) updateFields.stock = stock === null ? null : parseInt(stock, 10);
            if (published !== undefined) updateFields.published = !!published;
            if (extra_metadata !== undefined) updateFields.extra_metadata = (extra_metadata && typeof extra_metadata === 'object') ? extra_metadata : {};
            if (Number.isInteger(sort_order)) updateFields.sort_order = sort_order;

            let priceChanged = false;
            if (price_dollars !== undefined) {
                const priceCents = Math.round(parseFloat(price_dollars) * 100);
                if (!Number.isInteger(priceCents) || priceCents <= 0) {
                    return res.status(400).json({ error: 'Invalid price.' });
                }
                if (priceCents !== existing.price_cents) {
                    updateFields.price_cents = priceCents;
                    priceChanged = true;
                }
            }
            updateFields.updated_at = new Date().toISOString();

            const { data: product, error: updErr } = await supabaseAdmin.from('products').update(updateFields).eq('id', id).select().single();
            if (updErr) throw updErr;

            if (variants !== undefined) {
                await replaceVariants(id, variants);
            }

            const syncResult = await syncProductToStripe({ ...product, __priceChanged: priceChanged });
            return res.status(200).json({ product, sync: syncResult });
        }

        if (action === 'delete') {
            const { id } = req.body;
            if (!id) return res.status(400).json({ error: 'Missing id.' });

            const { data: product, error: fetchErr } = await supabaseAdmin.from('products').select('*').eq('id', id).single();
            if (fetchErr || !product) return res.status(404).json({ error: 'Product not found.' });

            // Soft delete: preserves order-history integrity (restock_log/purchases still
            // reference this product id), and Stripe products with historical orders can't be
            // hard-deleted anyway.
            const { error: updErr } = await supabaseAdmin.from('products').update({ published: false }).eq('id', id);
            if (updErr) throw updErr;

            const archiveResult = await archiveProductInStripe(product);
            return res.status(200).json({ ok: true, stripeArchive: archiveResult });
        }

        if (action === 'retry_stripe_sync') {
            const { id } = req.body;
            if (!id) return res.status(400).json({ error: 'Missing id.' });
            const { data: product, error: fetchErr } = await supabaseAdmin.from('products').select('*').eq('id', id).single();
            if (fetchErr || !product) return res.status(404).json({ error: 'Product not found.' });
            const syncResult = await syncProductToStripe(product);
            return res.status(200).json({ sync: syncResult });
        }

        return res.status(400).json({ error: 'Unknown action.' });
    } catch (error) {
        console.error('Admin products endpoint error:', error);
        res.status(500).json({ error: error.message });
    }
}
