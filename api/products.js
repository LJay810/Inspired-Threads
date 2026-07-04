const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // THE FIX: Uses Auto-Pagination to pull up to 1,000 products, bypassing the 100 limit cap!
        const products = await stripe.products.list({
            active: true,
            limit: 100, 
            expand: ['data.default_price'],
        }).autoPagingToArray({ limit: 1000 }); 

        // Filter out any products missing a price, then format
        const formattedProducts = products
            .filter(product => product.default_price && product.default_price.unit_amount) 
            .map(product => ({
                id: product.id,
                name: product.name,
                description: product.description,
                images: product.images,
                metadata: product.metadata,
                price: (product.default_price.unit_amount / 100).toFixed(2), 
                priceId: product.default_price.id
            }));

        res.status(200).json(formattedProducts);
    } catch (error) {
        console.error("Stripe API Error:", error.message);
        res.status(500).json({ error: error.message });
    }
}