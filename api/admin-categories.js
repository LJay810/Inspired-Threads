const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { requireAdmin } = require('../lib/require-admin');

const LAYOUT_TYPES = ['variant-apparel', 'gallery', 'design-attach', 'simple'];

function slugify(label) {
    return String(label).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
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
            const { data: categories, error } = await supabaseAdmin
                .from('categories')
                .select('*')
                .order('sort_order', { ascending: true });
            if (error) throw error;

            // Product counts per category, fetched separately (rather than an embedded FK
            // select) since category_id and sub_category_id both reference this same table,
            // which makes Postgrest's relationship-name inference ambiguous.
            const { data: productCategoryIds, error: countErr } = await supabaseAdmin.from('products').select('category_id');
            if (countErr) throw countErr;
            const counts = {};
            for (const row of productCategoryIds || []) counts[row.category_id] = (counts[row.category_id] || 0) + 1;

            const categoriesWithCounts = (categories || []).map(c => ({ ...c, product_count: counts[c.id] || 0 }));
            return res.status(200).json({ categories: categoriesWithCounts });
        }

        if (action === 'create') {
            const { label, id, parent_id, filter_group, card_layout_type, sort_order, size_chart_image_url, config } = req.body;
            if (!label || !card_layout_type) {
                return res.status(400).json({ error: 'Missing label or card_layout_type.' });
            }
            if (!LAYOUT_TYPES.includes(card_layout_type)) {
                return res.status(400).json({ error: `card_layout_type must be one of: ${LAYOUT_TYPES.join(', ')}` });
            }
            const categoryId = (id && slugify(id)) || slugify(label);
            if (!categoryId) return res.status(400).json({ error: 'Could not derive a valid category id/slug from the label.' });

            const { data, error } = await supabaseAdmin.from('categories').insert({
                id: categoryId,
                label,
                parent_id: parent_id || null,
                filter_group: filter_group || null,
                card_layout_type,
                sort_order: Number.isInteger(sort_order) ? sort_order : 99,
                size_chart_image_url: size_chart_image_url || null,
                config: config || {},
                active: true,
            }).select().single();
            if (error) {
                if (error.code === '23505') return res.status(400).json({ error: `A category with id "${categoryId}" already exists.` });
                throw error;
            }
            return res.status(200).json({ category: data });
        }

        if (action === 'update') {
            const { id, label, parent_id, filter_group, card_layout_type, sort_order, size_chart_image_url, config, active } = req.body;
            if (!id) return res.status(400).json({ error: 'Missing id.' });
            if (card_layout_type && !LAYOUT_TYPES.includes(card_layout_type)) {
                return res.status(400).json({ error: `card_layout_type must be one of: ${LAYOUT_TYPES.join(', ')}` });
            }

            const updateFields = {};
            if (label !== undefined) updateFields.label = label;
            if (parent_id !== undefined) updateFields.parent_id = parent_id || null;
            if (filter_group !== undefined) updateFields.filter_group = filter_group || null;
            if (card_layout_type !== undefined) updateFields.card_layout_type = card_layout_type;
            if (sort_order !== undefined) updateFields.sort_order = Number.isInteger(sort_order) ? sort_order : 99;
            if (size_chart_image_url !== undefined) updateFields.size_chart_image_url = size_chart_image_url || null;
            if (config !== undefined) updateFields.config = config;
            if (active !== undefined) updateFields.active = !!active;

            if (Object.keys(updateFields).length === 0) {
                return res.status(400).json({ error: 'Nothing to update.' });
            }

            const { data, error } = await supabaseAdmin.from('categories').update(updateFields).eq('id', id).select().single();
            if (error) throw error;
            return res.status(200).json({ category: data });
        }

        if (action === 'delete') {
            const { id } = req.body;
            if (!id) return res.status(400).json({ error: 'Missing id.' });

            const { count: productCount, error: countErr } = await supabaseAdmin
                .from('products')
                .select('id', { count: 'exact', head: true })
                .or(`category_id.eq.${id},sub_category_id.eq.${id}`);
            if (countErr) throw countErr;
            if (productCount > 0) {
                return res.status(400).json({ error: `Cannot delete: ${productCount} product(s) still reference this category. Reassign or delete them first.` });
            }

            const { count: childCount, error: childErr } = await supabaseAdmin
                .from('categories')
                .select('id', { count: 'exact', head: true })
                .eq('parent_id', id);
            if (childErr) throw childErr;
            if (childCount > 0) {
                return res.status(400).json({ error: `Cannot delete: ${childCount} sub-category(ies) still reference this category as their parent.` });
            }

            const { error } = await supabaseAdmin.from('categories').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ ok: true });
        }

        return res.status(400).json({ error: 'Unknown action.' });
    } catch (error) {
        console.error('Admin categories endpoint error:', error);
        res.status(500).json({ error: error.message });
    }
}
