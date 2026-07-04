// api/products.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // Fetch active products, expanding the default price data
        const products = await stripe.products.list({
            active: true,
            limit: 200,
            expand: ['data.default_price'],
        });

        // Format the data for your frontend
        const formattedProducts = products.data.map(product => ({
            id: product.id,
            name: product.name,
            description: product.description,
            images: product.images, // <--- CHANGED: Passes the entire array of image URLs from Stripe
            metadata: product.metadata, // Crucial for the hasVariants and category logic
            price: (product.default_price.unit_amount / 100).toFixed(2), 
            priceId: product.default_price.id
        }));

        res.status(200).json(formattedProducts);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}