const { Redis } = require('@upstash/redis');
const kv = Redis.fromEnv();
const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { requireAdmin } = require('../lib/require-admin');
const { syncProductToStripe, archiveProductInStripe } = require('../lib/stripe-sync');
const { applyStockChange } = require('../lib/apply-stock-change');

// Redis is the live source of truth the storefront actually reads (see api/products.js) --
// Supabase's stock/product_variants.stock columns are only a cold-storage mirror, re-seeded from
// Supabase ONLY when Redis has nothing cached yet for that key. Without this, editing stock here
// would update Supabase but silently have zero effect on the live site for any product/variant
// Redis already has a value for -- exactly the bug this function exists to close.
async function syncStockToRedis(productId, stripeMetaKey, qty) {
    const redisKey = `stock_${productId}_${stripeMetaKey}`;
    if (qty === null || qty === undefined) {
        await kv.del(redisKey); // explicitly cleared back to untracked/unlimited
    } else {
        await kv.set(redisKey, qty);
    }
}

// Variants payload shape from admin.html's product form: [{ size, color, color_image_url, stock }, ...]
async function replaceVariants(productId, variants, adminUserId, adminLabel) {
    if (!Array.isArray(variants)) return;

    // Snapshot existing stock levels BEFORE the delete, keyed by size|color, so the delete+
    // reinsert below can tell which rows actually changed -- only those go through
    // applyStockChange (Graveyard move/restore, wishlist notify, restock_log), matching what a
    // restock through the dedicated Restock tab would do. Untouched rows keep the plain Redis
    // sync they always had.
    const { data: existingRows } = await supabaseAdmin.from('product_variants').select('size, color, stock').eq('product_id', productId);
    const previousStockByKey = {};
    (existingRows || []).forEach(r => { previousStockByKey[`${r.size}|${r.color}`] = r.stock; });

    const { error: delErr } = await supabaseAdmin.from('product_variants').delete().eq('product_id', productId);
    if (delErr) throw delErr;

    const rows = variants.map(v => ({
        product_id: productId,
        size: v.size,
        color: v.color,
        color_image_url: v.color_image_url || null,
        stock: Number.isInteger(v.stock) ? v.stock : (parseInt(v.stock, 10) || 0),
    }));

    if (rows.length > 0) {
        const { error: insErr } = await supabaseAdmin.from('product_variants').insert(rows);
        if (insErr) throw insErr;
    }

    // Keep Redis in sync too -- see syncStockToRedis above for why this matters.
    const newKeys = new Set(rows.map(r => `${r.size}|${r.color}`));
    for (const row of rows) {
        const stripeMetaKey = `stock_${row.size}_${row.color}`;
        if (previousStockByKey[`${row.size}|${row.color}`] !== row.stock) {
            await applyStockChange(supabaseAdmin, kv, { productId, stripeMetaKey, newQuantity: row.stock, adminUserId, adminLabel });
        } else {
            await syncStockToRedis(productId, stripeMetaKey, row.stock);
        }
    }

    // A color/size removed from the matrix entirely (no longer in `variants`) needs its Redis
    // key cleared too -- otherwise a stale count lingers forever since nothing else ever
    // re-syncs or deletes it once the row is gone from product_variants.
    for (const key of Object.keys(previousStockByKey)) {
        if (!newKeys.has(key)) {
            const [size, color] = key.split('|');
            await syncStockToRedis(productId, `stock_${size}_${color}`, null);
        }
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const auth = await requireAdmin(req);
        if (auth.error) return res.status(auth.status).json({ error: auth.error });
        const adminLabel = auth.username || auth.callerId;

        const { action } = req.body;

        if (action === 'list') {
            const { category_id, search, published } = req.body;
            let query = supabaseAdmin.from('products').select('*, product_variants(*)').order('sort_order', { ascending: true });
            // Matches EITHER column -- a product's top-level category_id is always the parent
            // (e.g. 'dtf'), never a sub-category like 'dtf-kids', which only ever lives in
            // sub_category_id. Filtering on category_id alone meant picking a sub-category from
            // this dropdown always returned zero results.
            if (category_id) query = query.or(`category_id.eq.${category_id},sub_category_id.eq.${category_id}`);
            if (published !== undefined) query = query.eq('published', !!published);
            if (search) query = query.ilike('name', `%${search}%`);
            const { data, error } = await query;
            if (error) throw error;
            return res.status(200).json({ products: data || [] });
        }

        if (action === 'create') {
            const { name, description, category_id, price_dollars, images, dtf_placement, sub_category_id, stock, variants, extra_metadata, sort_order, published, is_golden_ticket } = req.body;
            if (!name || !category_id || price_dollars === undefined) {
                return res.status(400).json({ error: 'Missing name, category_id, or price_dollars.' });
            }

            // Only ever ONE product golden at a time -- see the identical comment in the
            // 'update' action below.
            if (is_golden_ticket) {
                const { error: clearErr } = await supabaseAdmin.from('products').update({ is_golden_ticket: false }).eq('is_golden_ticket', true);
                if (clearErr) throw clearErr;
            }
            const priceCents = Math.round(parseFloat(price_dollars) * 100);
            if (!Number.isInteger(priceCents) || priceCents <= 0) {
                return res.status(400).json({ error: 'Invalid price.' });
            }

            const { data: category, error: catErr } = await supabaseAdmin.from('categories').select('*').eq('id', category_id).single();
            if (catErr || !category) return res.status(400).json({ error: 'Unknown category_id.' });

            // Default a new product to the FRONT of its own category (newest first) unless an
            // explicit sort_order was given -- one lower than whatever's currently lowest in
            // this category, so it's guaranteed to sort ahead of everything already there.
            // Falls back to 1 for the very first product ever added to a category. Sort order
            // is a single global ranking, but since the storefront only ever displays one
            // category at a time (filtering just hides the rest), "lowest within this category"
            // is what actually controls where it visually lands.
            let resolvedSortOrder = sort_order;
            if (!Number.isInteger(resolvedSortOrder)) {
                const { data: lowestInCategory } = await supabaseAdmin
                    .from('products')
                    .select('sort_order')
                    .eq('category_id', category_id)
                    .order('sort_order', { ascending: true })
                    .limit(1)
                    .maybeSingle();
                resolvedSortOrder = (lowestInCategory && Number.isInteger(lowestInCategory.sort_order))
                    ? lowestInCategory.sort_order - 1
                    : 1;
            }

            const { data: product, error: insErr } = await supabaseAdmin.from('products').insert({
                name,
                description: description || null,
                category_id,
                images: Array.isArray(images) ? images : [],
                price_cents: priceCents,
                sort_order: resolvedSortOrder,
                dtf_placement: dtf_placement || null,
                sub_category_id: sub_category_id || null,
                stock: category.card_layout_type === 'variant-apparel' ? null : (stock !== undefined && stock !== null ? parseInt(stock, 10) : null),
                extra_metadata: extra_metadata && typeof extra_metadata === 'object' ? extra_metadata : {},
                published: published !== undefined ? !!published : true,
                is_golden_ticket: !!is_golden_ticket,
            }).select().single();
            if (insErr) throw insErr;

            let finalProduct = product;
            if (category.card_layout_type === 'variant-apparel') {
                await replaceVariants(product.id, variants || [], auth.callerId, adminLabel);
                // Variant-apparel is never a DTF/Graveyard category, so category_id can't have
                // changed here -- no need for the re-fetch below.
            } else if (product.stock !== null) {
                await applyStockChange(supabaseAdmin, kv, { productId: product.id, stripeMetaKey: 'stock', newQuantity: product.stock, adminUserId: auth.callerId, adminLabel });
                // Re-fetch: a brand-new DTF product saved with 0 stock just got moved straight to
                // the Graveyard by applyStockChange above -- re-read so the Stripe mirror and the
                // response reflect that category_id, not the pre-move snapshot from insert() above.
                const { data: refreshed } = await supabaseAdmin.from('products').select('*').eq('id', product.id).single();
                if (refreshed) finalProduct = refreshed;
            } else {
                await syncStockToRedis(product.id, 'stock', null);
            }

            const syncResult = await syncProductToStripe(finalProduct);
            return res.status(200).json({ product: finalProduct, sync: syncResult });
        }

        if (action === 'update') {
            const { id, name, description, category_id, price_dollars, images, dtf_placement, sub_category_id, stock, variants, published, extra_metadata, sort_order, is_golden_ticket } = req.body;
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
            if (is_golden_ticket !== undefined) {
                updateFields.is_golden_ticket = !!is_golden_ticket;
                // Only ever ONE product golden at a time -- clearing it here (rather than
                // trusting the admin to remember to un-flag whichever one currently has it)
                // means "make THIS one the Golden Ticket" is always a single, safe click.
                if (is_golden_ticket) {
                    const { error: clearErr } = await supabaseAdmin.from('products').update({ is_golden_ticket: false }).eq('is_golden_ticket', true).neq('id', id);
                    if (clearErr) throw clearErr;
                }
            }

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

            let finalProduct = product;
            if (variants !== undefined) {
                await replaceVariants(id, variants, auth.callerId, adminLabel);
                // Variant-apparel is never a DTF/Graveyard category, so category_id can't have
                // changed here -- no need for the re-fetch below.
            } else if (stock !== undefined) {
                if (updateFields.stock !== null) {
                    await applyStockChange(supabaseAdmin, kv, { productId: id, stripeMetaKey: 'stock', newQuantity: updateFields.stock, adminUserId: auth.callerId, adminLabel });
                    // Re-fetch: zeroing stock (or restoring it) above may have just changed
                    // category_id via the Graveyard move/restore in applyStockChange -- re-read
                    // so the Stripe mirror and the response reflect that, not the pre-move
                    // snapshot from the update() above.
                    const { data: refreshed } = await supabaseAdmin.from('products').select('*').eq('id', id).single();
                    if (refreshed) finalProduct = refreshed;
                } else {
                    await syncStockToRedis(id, 'stock', null);
                }
            }

            const syncResult = await syncProductToStripe({ ...finalProduct, __priceChanged: priceChanged });
            return res.status(200).json({ product: finalProduct, sync: syncResult });
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
