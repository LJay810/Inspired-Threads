const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        const cartItems = req.body.items;

        // Map frontend cart items to Stripe line items
        const lineItems = cartItems.map(item => {
            return {
                price: item.priceId,
                quantity: item.quantity,
                // Pass size/color variants to the Stripe receipt
                adjustable_quantity: { enabled: true, minimum: 1 },
            };
        });

        // Store the exact variants (Size/Color) as metadata so you see it on your Stripe dashboard
        const orderMetadata = cartItems.reduce((acc, item, index) => {
            acc[`Item_${index + 1}`] = `${item.name} - ${item.size || 'N/A'} - ${item.color || 'N/A'}`;
            return acc;
        }, {});

        // Create Checkout Session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: lineItems,
            mode: 'payment',
            metadata: orderMetadata,
            payment_intent_data: { metadata: orderMetadata }, // Ensures it shows on the payment page
            success_url: `${req.headers.origin}/?success=true`,
            cancel_url: `${req.headers.origin}/?canceled=true`,
        });

        res.status(200).json({ id: session.id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
}