// ONE-TIME migration: pulls the live Stripe catalog + the config that used to be hardcoded in
// index.html (variantConfig, dtfPlacements, the DTF pocket calibration matrix, the filter bar
// category tree) into the new Supabase categories/products/product_variants tables.
//
// This is a local script, not a deployed API route -- it should only ever be run once, by hand,
// against production, right before flipping api/products.js over to read from Supabase.
//
// EASIEST WAY TO RUN IT: pull your real Vercel env vars into a local file first (works even for
// vars marked "Sensitive" in the dashboard, unlike the dashboard's own copy button):
//   npm install -g vercel   (skip if already installed)
//   vercel login
//   vercel link
//   vercel env pull .env.local
//   node scripts/migrate-catalog.js
// This script auto-loads .env.local (or .env) below -- no manual copy/pasting into your shell
// needed. If you'd rather set them by hand instead, that still works too:
//   STRIPE_SECRET_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/migrate-catalog.js
//
// Re-running it is safe (upserts throughout) but not idempotent for stock -- it always writes
// whatever Redis's CURRENT live count is at the moment it runs, which is intentional (Redis is
// the live source of truth) but means running it twice, hours apart, could pick up stock changes
// that happened via the OLD admin-restock.js in between. Run it once, verify, then cut over.

// Minimal .env loader (no new dependency) -- only fills in a variable if it isn't already set
// in the real environment, so `$env:X = ...` in your shell still wins if you set it that way.
(function loadDotEnvIfPresent() {
    const fs = require('fs');
    const path = require('path');
    for (const filename of ['.env.local', '.env']) {
        const envPath = path.join(__dirname, '..', filename);
        if (!fs.existsSync(envPath)) continue;
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            let value = trimmed.slice(eqIdx + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (key && process.env[key] === undefined) process.env[key] = value;
        }
        console.log(`Loaded env vars from ${filename}`);
        break; // only load the first one found -- .env.local takes priority over .env
    }
})();

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Redis } = require('@upstash/redis');

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const kv = Redis.fromEnv();

// ============================================================================
// 1. Category seed data -- hand-transcribed out of index.html's dtfPlacements (~line 2089),
//    variantConfig (~line 2106), the pocket calibration matrix + center-chest branches inside
//    applyDtfToTarget() (~lines 2916-2968), and the filter bar (~lines 1662-1676).
// ============================================================================

const THREAD_SIZES = {
    'thread-tshirt': ['Small', 'Medium', 'Large', 'XL', 'XXL', '3X', '4X', 'YXS', 'YS', 'YM', 'YL', 'YXL'],
    'thread-hoodie': ['Small', 'Medium', 'Large', 'XL', 'XXL', '3X', '4X', 'YXS', 'YS', 'YM', 'YL', 'YXL'],
    'thread-crewneck': ['Small', 'Medium', 'Large', 'XL', '3X', '4X', 'YXS', 'YS', 'YM', 'YL', 'YXL'],
    'thread-tanktop': ['Small', 'Medium', 'Large', '3X', '4X', 'YXS', 'YS', 'YM', 'YL', 'YXL'],
};

// Old variantConfig[category].colors -- shared color->image map, now becomes the seed for each
// existing product's own product_variants.color_image_url (see §3 below). Kept here only as the
// migration's data source, not written verbatim into categories.config.
const THREAD_COLORS = {
    'thread-tshirt': {
        'Black': 'images/IMG_8033.JPEG', 'White': 'images/IMG_8034.JPEG', 'Gray': 'images/GreyTShirt.png',
        'RoyalBlue': 'images/RoyalBlueT.png', 'LightBlue': 'images/LightBlueT.png', 'NavyBlue': 'images/NavyBlueShirt.png',
        'Violet': 'images/VioletT.png', 'Purple': 'images/PurpleT.png', 'Sand': 'images/SandT.png',
        'HotPink': 'images/HotPinkT.png', 'LightPink': 'images/LightPink.png', 'IrishGreen': 'images/IrishGreenT.png',
        'SageGreen': 'images/SageGreenT.JPEG', 'Orange': 'images/OrangeT.png', 'Yellow': 'images/YellowT.png',
        'Red': 'images/RedT.png', 'ForestGreen': 'images/ForestGreen.png', 'BurntOrange': 'images/BurntOrange.png',
    },
    'thread-hoodie': {
        'Black': 'images/BlackHoodie.png', 'Navy': 'images/NavyHoodie.png', 'Pink': 'images/PinkHoodie.png',
        'Red': 'images/RedHoodie.png', 'White': 'images/WhiteHoodie.png', 'Sport Grey': 'images/SportGreyHoodie.png',
        'Sand': 'images/SandHoodie.png', 'Charcoal': 'images/CharcoalHoodie.png', 'Purple': 'images/PurpleHoodie.png',
        'ForestGreen': 'images/ForestGreenHoodie.png', 'Orange': 'images/OrangeHoodie.png', 'Maroon': 'images/MaroonHoodie.png',
        'Mint Green': 'images/MintGreenHoodie.png',
    },
    'thread-crewneck': {
        'Black': 'images/BlackCrewNeck.png', 'White': 'images/WhiteCrewNeck.png', 'Gray': 'images/AthleticGreyCrewNeck.png',
        'LightPink': 'images/LightPinkCrewNeck.png', 'Sand': 'images/SandCrewNeck.png', 'Red': 'images/RedCrewNeck.png',
        'RoyalBlue': 'images/RoyalBlueCrewNeck.png', 'ForestGreen': 'images/ForestGreenCrewNeck.JPEG',
        'KellyGreen': 'images/KellyGreen.png', 'NavyBlue': 'images/NavyBlueCrewNeck.png', 'Violet': 'images/VioletCrewNeck.png',
        'HotPink': 'images/HotPink.png', 'Yellow': 'images/YellowCrewNeck.png', 'Purple': 'images/PurpleCrewNeck.png',
        'SageGreen': 'images/SageGreenCrewNeck.png', 'Orange': 'images/OrangeCrewNeck.png',
    },
    'thread-tanktop': {
        'Black': 'images/BlackTanktop.png', 'White': 'images/WhiteTankTop.png', 'Grey': 'images/GreyTankTop.png',
        'HotPink': 'images/HotPinkTankTop.png', 'TahitiBlue': 'images/TahitiBlueTankTop.png',
        'MilitaryGreen': 'images/MilitaryGreenTankTop.png', 'Indigo': 'images/IndigoTankTop.png',
        'Red': 'images/RedTankTop.png', 'RoyalBlue': 'images/RoyalBlue.png',
    },
};

const DTF_PLACEMENTS = {
    'thread-tshirt': { top: '28%', width: '18%', height: '40%', left: '41%' },
    'thread-hoodie': { top: '30%', width: '18%', height: '35%', left: '41%' },
    'thread-crewneck': { top: '30%', width: '18%', height: '38%', left: '41%' },
    'thread-tanktop': { top: '32%', width: '16%', height: '35%', left: '42%' },
    'corporate': { top: '48%', width: '40%', height: '40%', left: '30%' },
};

// From the pocket-design calibration matrix in applyDtfToTarget() -- reshaped from
// matrix[shape][category] into config[category].dtf_pocket_matrix[shape] per category.
const POCKET_MATRIX_BY_CATEGORY = {
    'thread-hoodie': { tall: { s: 0.60, x: 94, y: -23 }, wide: { s: 0.55, x: 100, y: -31 }, square: { s: 0.65, x: 93, y: -24 } },
    'thread-crewneck': { tall: { s: 0.50, x: 110, y: -23 }, wide: { s: 0.55, x: 100, y: -35 }, square: { s: 0.60, x: 85, y: -28 } },
    'thread-tshirt': { tall: { s: 0.55, x: 110, y: -47 }, wide: { s: 0.55, x: 100, y: -55 }, square: { s: 0.65, x: 85, y: -46 } },
    'thread-tanktop': { tall: { s: 0.50, x: 110, y: -32 }, wide: { s: 0.55, x: 89, y: -45 }, square: { s: 0.60, x: 85, y: -43 } },
};

// From the center-chest (non-pocket) branches in applyDtfToTarget(): corporate and thread-tshirt
// each get their own scale/y, everything else (hoodie/crewneck/tanktop) shares the same default.
const CENTER_CHEST_BY_CATEGORY = {
    'corporate': { scale: 1.1, y: -20 },
    'thread-tshirt': { scale: 1.35, y: -35 },
    'thread-hoodie': { scale: 1.35, y: -20 },
    'thread-crewneck': { scale: 1.35, y: -20 },
    'thread-tanktop': { scale: 1.35, y: -20 },
};

function threadCategoryRow(id, label, sortOrder) {
    return {
        id, label,
        parent_id: null,
        filter_group: 'thread',
        card_layout_type: 'variant-apparel',
        sort_order: sortOrder,
        size_chart_image_url: 'images/SizeChart.jpg',
        active: true,
        config: {
            sizes: THREAD_SIZES[id],
            // Fallback color list for products with no explicit product_variants rows (i.e. no
            // real per-size/color stock was ever configured in Stripe -- they were running
            // "untracked," any size/color combo always addable to cart). Without this, such a
            // product would show an empty color dropdown after migration instead of the full
            // list it always showed before. Products WITH real product_variants keep using
            // their own per-product colors (see index.html's renderVariantApparelCard).
            colors: THREAD_COLORS[id],
            dtf_default_placement: DTF_PLACEMENTS[id] || null,
            dtf_center_chest: CENTER_CHEST_BY_CATEGORY[id] || null,
            dtf_pocket_matrix: POCKET_MATRIX_BY_CATEGORY[id] || null,
        },
    };
}

const CATEGORY_SEED = [
    { id: 'dtf', label: 'DTF Transfers', parent_id: null, filter_group: 'dtf', card_layout_type: 'simple', sort_order: 1, size_chart_image_url: null, active: true, config: {} },
    { id: 'dtf-pocket', label: "Pocket DTF's", parent_id: 'dtf', filter_group: 'dtf', card_layout_type: 'simple', sort_order: 2, size_chart_image_url: null, active: true, config: {} },
    { id: 'dtf-kids', label: "Kid's DTF's", parent_id: 'dtf', filter_group: 'dtf', card_layout_type: 'simple', sort_order: 3, size_chart_image_url: null, active: true, config: {} },
    threadCategoryRow('thread-tshirt', 'T-Shirts', 4),
    threadCategoryRow('thread-hoodie', 'Hoodies', 5),
    threadCategoryRow('thread-crewneck', 'Crewnecks', 6),
    threadCategoryRow('thread-tanktop', 'Tank Tops', 7),
    { id: 'loaded-binders', label: 'Loaded Binders', parent_id: null, filter_group: 'loaded-binders', card_layout_type: 'gallery', sort_order: 8, size_chart_image_url: null, active: true, config: { max_thumbnails: 4 } },
    {
        id: 'corporate', label: 'Graphic Tote Bags', parent_id: null, filter_group: 'corporate',
        card_layout_type: 'design-attach', sort_order: 9, size_chart_image_url: null, active: true,
        config: { dtf_default_placement: DTF_PLACEMENTS['corporate'], dtf_center_chest: CENTER_CHEST_BY_CATEGORY['corporate'] },
    },
];

// ============================================================================
// 2. Helpers
// ============================================================================

function resolveSubCategory(product) {
    if (product.metadata && product.metadata.sub_category) return product.metadata.sub_category;
    const name = (product.name || '').toLowerCase();
    if (name.includes('pocket')) return 'dtf-pocket';
    if (name.includes('kid') || name.includes('youth')) return 'dtf-kids';
    return null;
}

async function liveStockFor(productId, stripeMetaKey, fallbackFromMetadata) {
    const redisKey = `stock_${productId}_${stripeMetaKey}`;
    const live = await kv.get(redisKey);
    if (live !== null) return parseInt(live, 10) || 0;
    return parseInt(fallbackFromMetadata, 10) || 0;
}

function dtfPlacementOverride(metadata) {
    if (!metadata || !metadata.dtf_top) return null;
    return {
        top: metadata.dtf_top,
        left: metadata.dtf_left,
        width: metadata.dtf_width,
        height: metadata.dtf_height,
    };
}

// Everything else NOT covered by a fixed products column -- most importantly the DTF design
// visualizer's per-garment overrides (scale_<shortCategory>, nudge_x_<shortCategory>,
// nudge_y_<shortCategory>, visual_scale, nudge_x, nudge_y, design_type -- see openDtfSelector()
// in index.html). Captured verbatim into extra_metadata so nothing silently breaks for existing
// DTF design products after cutover.
const KNOWN_KEYS = new Set([
    'category', 'hasVariants', 'sub_category', 'sort_order',
    'dtf_top', 'dtf_left', 'dtf_width', 'dtf_height',
    'thumb1', 'thumb2', 'thumb3', 'thumb4', 'stock',
]);
function extraMetadata(metadata) {
    const extra = {};
    for (const key of Object.keys(metadata || {})) {
        if (KNOWN_KEYS.has(key) || key.startsWith('stock_')) continue;
        extra[key] = metadata[key];
    }
    return extra;
}

// ============================================================================
// 3. Main
// ============================================================================

function checkRequiredEnvVars() {
    const required = ['STRIPE_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        console.error(`\nMissing required environment variable(s): ${missing.join(', ')}`);
        console.error('Set them in your shell, or run `vercel env pull .env.local` first -- see the comment at the top of this file.\n');
        process.exit(1);
    }
}

async function main() {
    checkRequiredEnvVars();

    console.log('--- Step 1: seeding categories ---');
    const { error: catErr } = await supabaseAdmin.from('categories').upsert(CATEGORY_SEED, { onConflict: 'id' });
    if (catErr) throw catErr;
    console.log(`Seeded ${CATEGORY_SEED.length} categories.`);

    console.log('--- Step 2: fetching live Stripe catalog ---');
    const stripeProducts = await stripe.products.list({
        active: true, limit: 100, expand: ['data.default_price'],
    }).autoPagingToArray({ limit: 1000 });
    console.log(`Found ${stripeProducts.length} active Stripe products.`);

    const summary = { migrated: 0, skipped: [] };

    for (const product of stripeProducts) {
        if (!product.default_price || !product.default_price.unit_amount) {
            summary.skipped.push({ id: product.id, name: product.name, reason: 'no default_price/unit_amount' });
            continue;
        }

        const metadata = product.metadata || {};
        const categoryId = metadata.category || 'dtf';
        const isKnownCategory = CATEGORY_SEED.some(c => c.id === categoryId);
        if (!isKnownCategory) {
            summary.skipped.push({ id: product.id, name: product.name, reason: `unknown category "${categoryId}"` });
            continue;
        }

        const hasVariants = metadata.hasVariants === 'true' && THREAD_SIZES[categoryId];
        const subCategoryId = categoryId === 'dtf' ? resolveSubCategory(product) : null;

        // images[]: for gallery (loaded-binders), append thumb1-4 metadata after the main Stripe
        // image so the new single `images` array carries everything the old separate
        // metadata.thumb1..4 fields used to.
        let images = Array.isArray(product.images) ? [...product.images] : [];
        if (categoryId === 'loaded-binders') {
            for (let i = 1; i <= 4; i++) {
                const thumb = metadata[`thumb${i}`];
                if (thumb) images.push(thumb);
            }
        }

        const productRow = {
            id: product.id, // preserved verbatim -- existing Redis keys (stock_<productId>_<key>) depend on this
            category_id: categoryId,
            name: product.name,
            description: product.description || null,
            images,
            price_cents: product.default_price.unit_amount,
            sort_order: parseInt(metadata.sort_order, 10) || 99,
            published: true,
            dtf_placement: dtfPlacementOverride(metadata),
            sub_category_id: subCategoryId,
            stock: null,
            extra_metadata: extraMetadata(metadata),
            stripe_product_id: product.id,
            stripe_price_id: product.default_price.id,
            stripe_sync_status: 'ok',
            stripe_sync_error: null,
        };

        if (hasVariants) {
            // Only migrate size/color combos that actually have a stock_<Size>_<Color> key in
            // Stripe metadata today -- NOT the full sizes x colors cross-product, since not
            // every color is necessarily stocked for every product.
            const variantRows = [];
            for (const key of Object.keys(metadata)) {
                const match = key.match(/^stock_(.+)_(.+)$/);
                if (!match) continue;
                const [, size, color] = match;
                const stock = await liveStockFor(product.id, key, metadata[key]);
                const colorImage = (THREAD_COLORS[categoryId] && THREAD_COLORS[categoryId][color]) || null;
                variantRows.push({ product_id: product.id, size, color, color_image_url: colorImage, stock });
            }

            const { error: prodErr } = await supabaseAdmin.from('products').upsert(productRow, { onConflict: 'id' });
            if (prodErr) throw prodErr;

            if (variantRows.length > 0) {
                const { error: varErr } = await supabaseAdmin
                    .from('product_variants')
                    .upsert(variantRows, { onConflict: 'product_id,size,color' });
                if (varErr) throw varErr;
            }
            console.log(`Migrated "${product.name}" (${categoryId}) with ${variantRows.length} variant(s).`);
        } else {
            const stock = metadata.stock !== undefined
                ? await liveStockFor(product.id, 'stock', metadata.stock)
                : null; // untracked / made-to-order, matches the old "no stock key = unlimited" convention
            productRow.stock = stock;

            const { error: prodErr } = await supabaseAdmin.from('products').upsert(productRow, { onConflict: 'id' });
            if (prodErr) throw prodErr;
            console.log(`Migrated "${product.name}" (${categoryId}${subCategoryId ? '/' + subCategoryId : ''}), stock=${stock === null ? 'untracked' : stock}.`);
        }

        summary.migrated++;
    }

    console.log('\n--- Migration summary ---');
    console.log(`Migrated: ${summary.migrated}`);
    console.log(`Skipped: ${summary.skipped.length}`);
    if (summary.skipped.length > 0) {
        console.table(summary.skipped);
    }
    console.log('\nReview the above, then verify with a manual spot-check in Supabase before flipping api/products.js live.');
}

main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
