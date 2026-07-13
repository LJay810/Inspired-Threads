const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Public, read-only category config for the storefront -- replaces the hardcoded
// variantConfig/dtfPlacements/filter-bar structures that used to live in index.html.
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { data, error } = await supabaseAdmin
            .from('categories')
            .select('id, label, parent_id, filter_group, card_layout_type, sort_order, size_chart_image_url, config')
            .eq('active', true)
            .order('sort_order', { ascending: true });
        if (error) throw error;

        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        res.status(200).json(data || []);
    } catch (error) {
        console.error('Categories API error:', error.message);
        res.status(500).json({ error: error.message });
    }
}
