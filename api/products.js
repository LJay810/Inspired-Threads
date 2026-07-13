import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Catalog now lives in Supabase (categories/products/product_variants), not Stripe -- Stripe is
// only invisible payment plumbing (see lib/stripe-sync.js). Also serves category config (was
// its own api/categories.js endpoint, folded in here to stay under Vercel Hobby's 12-serverless-
// function cap) -- replaces the hardcoded variantConfig/dtfPlacements/filter-bar structures that
// used to live in index.html. Response shape: { products: [...], categories: [...] }.
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { data: categories, error: catErr } = await supabaseAdmin
            .from('categories')
            .select('id, label, parent_id, filter_group, card_layout_type, sort_order, size_chart_image_url, config, active')
            .order('sort_order', { ascending: true });
        if (catErr) throw catErr;
        const categoriesById = Object.fromEntries((categories || []).map(c => [c.id, c]));
        const activeCategories = (categories || []).filter(c => c.active);

        const { data: products, error: prodErr } = await supabaseAdmin
            .from('products')
            .select('*, product_variants(*)')
            .eq('published', true);
        if (prodErr) throw prodErr;

        const formattedProducts = await Promise.all(
            (products || []).map(async (product) => {
                const category = categoriesById[product.category_id];
                const hasVariants = !!category && category.card_layout_type === 'variant-apparel';

                const metadata = {
                    // extra_metadata first so the fixed fields below always win on key collision --
                    // it's a free-form escape hatch (DTF visualizer per-garment overrides like
                    // scale_tshirt/nudge_x_hoodie/design_type), not meant to shadow known fields.
                    ...(product.extra_metadata || {}),
                    category: product.category_id,
                    hasVariants: hasVariants ? 'true' : 'false',
                    sort_order: (product.sort_order != null ? product.sort_order : 99).toString(),
                };
                if (product.sub_category_id) metadata.sub_category = product.sub_category_id;
                if (product.dtf_placement) {
                    if (product.dtf_placement.top) metadata.dtf_top = product.dtf_placement.top;
                    if (product.dtf_placement.left) metadata.dtf_left = product.dtf_placement.left;
                    if (product.dtf_placement.width) metadata.dtf_width = product.dtf_placement.width;
                    if (product.dtf_placement.height) metadata.dtf_height = product.dtf_placement.height;
                }

                // Gallery layout (loaded-binders): images[0] is the main photo, images[1..4]
                // become metadata.thumb1..4, matching the old separate-metadata-fields contract.
                if (category && category.card_layout_type === 'gallery' && product.images && product.images.length > 1) {
                    product.images.slice(1, 5).forEach((url, i) => { metadata[`thumb${i + 1}`] = url; });
                }

                // Seed the raw (pre-live) stock number(s) into metadata, same shape as the old
                // Stripe-metadata contract, before the Redis overlay loop below makes them live.
                if (hasVariants) {
                    for (const variant of product.product_variants || []) {
                        metadata[`stock_${variant.size}_${variant.color}`] = variant.stock.toString();
                    }
                } else if (product.stock !== null && product.stock !== undefined) {
                    metadata.stock = product.stock.toString();
                }

                // Live Redis overlay -- unchanged logic from before, just seeded from the
                // Supabase mirror instead of Stripe metadata on first read.
                for (const key of Object.keys(metadata)) {
                    if (key.startsWith('stock_') || key === 'stock') {
                        const redisKey = `stock_${product.id}_${key}`;
                        let liveStock = await kv.get(redisKey);
                        if (liveStock === null) {
                            liveStock = parseInt(metadata[key], 10) || 0;
                            await kv.set(redisKey, liveStock);
                        }
                        metadata[key] = liveStock.toString();
                    }
                }

                // Per-product variant list (size/color/image) -- replaces the old shared,
                // category-wide variantConfig.colors map. Each product can now have its own
                // photo per color instead of every product in a category being forced to share
                // the same color->image map.
                const variants = hasVariants
                    ? (product.product_variants || []).map(v => ({ size: v.size, color: v.color, colorImageUrl: v.color_image_url }))
                    : [];

                return {
                    id: product.id,
                    name: product.name,
                    description: product.description,
                    images: product.images || [],
                    metadata,
                    variants,
                    price: (product.price_cents / 100).toFixed(2),
                    priceId: product.stripe_price_id,
                };
            })
        );

        res.status(200).json({ products: formattedProducts, categories: activeCategories });
    } catch (error) {
        console.error('Products API error:', error.message);
        res.status(500).json({ error: error.message });
    }
}
