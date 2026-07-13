// Syncs our own Supabase catalog (source of truth) OUT to Stripe (invisible payment plumbing).
// Called only from api/admin-products.js (product create/update/delete) and api/admin-restock.js
// (stock mirror). Never called from the storefront or from admin.html directly -- the admin UI
// only ever talks to our own API routes, which call this.
//
// A Stripe failure here must never block or roll back the Supabase write that triggered it: the
// catalog write commits first, and any sync error is recorded on the product row
// (stripe_sync_status/stripe_sync_error) so admin.html can show a retryable warning instead of
// silently losing the admin's edit.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Creates (first save) or updates the Stripe Product+Price mirror for a catalog product.
// `product` is a row from public.products (already written to Supabase by the caller).
// Returns { stripe_product_id, stripe_price_id } to persist back onto the row, and never
// throws -- callers get { ok: false, error } instead so a Stripe outage degrades gracefully.
async function syncProductToStripe(product) {
    try {
        let stripeProductId = product.stripe_product_id;
        let stripePriceId = product.stripe_price_id;

        const productFields = {
            name: product.name,
            description: product.description || undefined,
            images: (product.images || []).filter(url => /^https?:\/\//.test(url)), // Stripe rejects relative paths
            // Keeps Stripe's own active flag in lockstep with our `published` column -- so
            // restoring an archived product (published: false -> true) automatically
            // reactivates its Stripe product too. An archived Stripe product can't be used to
            // create new Checkout Sessions, so without this a "restored" product would still be
            // unbuyable even though it looks live again in the admin panel and on the storefront.
            active: product.published !== false,
            metadata: {
                category: product.category_id,
                sort_order: String(product.sort_order != null ? product.sort_order : 99),
                catalog_source: 'supabase', // marks this product as admin-panel-managed, for anyone reading the Stripe Dashboard directly
            },
        };

        if (!stripeProductId) {
            const created = await stripe.products.create(productFields);
            stripeProductId = created.id;

            const price = await stripe.prices.create({
                product: stripeProductId,
                unit_amount: product.price_cents,
                currency: 'usd',
            });
            stripePriceId = price.id;

            await stripe.products.update(stripeProductId, { default_price: stripePriceId });
        } else {
            await stripe.products.update(stripeProductId, productFields);

            // Stripe Prices are immutable -- a price change means create-new + repoint + archive-old,
            // never an update of the existing Price object.
            if (product.__priceChanged) {
                const newPrice = await stripe.prices.create({
                    product: stripeProductId,
                    unit_amount: product.price_cents,
                    currency: 'usd',
                });
                await stripe.products.update(stripeProductId, { default_price: newPrice.id });
                if (stripePriceId) {
                    await stripe.prices.update(stripePriceId, { active: false }).catch(() => {});
                }
                stripePriceId = newPrice.id;
            }
        }

        await supabaseAdmin.from('products').update({
            stripe_product_id: stripeProductId,
            stripe_price_id: stripePriceId,
            stripe_sync_status: 'ok',
            stripe_sync_error: null,
        }).eq('id', product.id);

        return { ok: true, stripe_product_id: stripeProductId, stripe_price_id: stripePriceId };
    } catch (err) {
        console.error(`Stripe sync failed for product ${product.id}:`, err.message);
        await supabaseAdmin.from('products').update({
            stripe_sync_status: 'error',
            stripe_sync_error: err.message,
        }).eq('id', product.id).catch(() => {});
        return { ok: false, error: err.message };
    }
}

// Cosmetic-only mirror of a stock number into the Stripe product's own metadata, purely so the
// Stripe Dashboard reads correctly if an admin ever opens it directly. Never the source of truth.
async function syncVariantStockToStripe(productId, stripeMetaKey, qty) {
    const { data: product } = await supabaseAdmin.from('products').select('stripe_product_id').eq('id', productId).single();
    if (!product || !product.stripe_product_id) return { ok: false, error: 'No linked Stripe product' };

    const stripeProduct = await stripe.products.retrieve(product.stripe_product_id);
    await stripe.products.update(product.stripe_product_id, {
        metadata: { ...stripeProduct.metadata, [stripeMetaKey]: qty.toString() },
    });
    return { ok: true };
}

// Stripe products with historical orders attached can't be hard-deleted -- archiving (active:false)
// is the correct "delete" for a Product that's ever been sold.
async function archiveProductInStripe(product) {
    if (!product.stripe_product_id) return { ok: true };
    try {
        await stripe.products.update(product.stripe_product_id, { active: false });
        return { ok: true };
    } catch (err) {
        console.error(`Stripe archive failed for product ${product.id}:`, err.message);
        return { ok: false, error: err.message };
    }
}

module.exports = { syncProductToStripe, syncVariantStockToStripe, archiveProductInStripe };
