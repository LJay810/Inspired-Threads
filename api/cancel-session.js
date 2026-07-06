const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    try {
        const { sessionId } = req.body;
        if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        // Only expire it if it's still open — avoids errors if this somehow
        // gets called twice (e.g. the customer hits back, then refreshes the page).
        if (session.status === 'open') {
            await stripe.checkout.sessions.expire(sessionId);
        }

        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Cancel-session error:', error);
        // Fail quietly toward the customer — this is a background convenience call,
        // not something that should ever block or error out their browsing experience.
        res.status(200).json({ ok: false });
    }
}