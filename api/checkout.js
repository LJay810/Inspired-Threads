const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        const cartItems = req.body.items;
        const lineItems = [];

        // --- DEFENSE LEVEL 1: THE VARIANT PRE-FLIGHT CHECK ---
        for (const item of cartItems) {
            const price = await stripe.prices.retrieve(item.priceId, { expand: ['product'] });
            const product = price.product;

            if (product.metadata && product.metadata.hasVariants === 'true') {
                // Generates the match string based on chosen dropdown state
                const stockKey = `stock_${item.size}_${item.color}`;
                if (product.metadata[stockKey] !== undefined) {
                    const currentStock = parseInt(product.metadata[stockKey]);
                    if (currentStock < item.quantity) {
                        return res.status(400).json({
                            error: `STOCK ALERT: ${product.name} (${item.size} / ${item.color}) only has ${currentStock} left.`
                        });
                    }
                }
            } else if (product.metadata && product.metadata.stock !== undefined) {
                // Global fallback for standard items like Binders
                const currentStock = parseInt(product.metadata.stock);
                if (currentStock < item.quantity) {
                    return res.status(400).json({
                        error: `STOCK ALERT: ${product.name} only has ${currentStock} left.`
                    });
                }
            }

            lineItems.push({
                price: item.priceId,
                quantity: item.quantity,
                adjustable_quantity: { enabled: true, minimum: 1 },
            });
        }

        const orderMetadata = cartItems.reduce((acc, item, index) => {
            acc[`Item_${index + 1}`] = `${item.name} - ${item.size || 'N/A'} - ${item.color || 'N/A'}`;
            return acc;
        }, {});

        // Build precise item mapping so webhook knows exactly which variant string to deduct
        const sessionMetadata = { ...orderMetadata };
        cartItems.forEach((item, index) => {
            sessionMetadata[`id_${index}`] = item.priceId;
            sessionMetadata[`size_${index}`] = item.size || 'N/A';
            sessionMetadata[`color_${index}`] = item.color || 'N/A';
            sessionMetadata[`qty_${index}`] = item.quantity.toString();
        });
        sessionMetadata[`item_count`] = cartItems.length.toString();

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: lineItems,
            mode: 'payment',
            metadata: sessionMetadata,
            payment_intent_data: { metadata: sessionMetadata }, 
            success_url: `${req.headers.origin}/?success=true`,
            cancel_url: `${req.headers.origin}/?canceled=true`,
        });

        res.status(200).json({ id: session.id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
}