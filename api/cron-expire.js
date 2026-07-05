const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    // Verify the request is authorized. If you use Vercel's own Cron scheduler, it sends this
    // header automatically. If you use an external pinger (see README), configure it to send
    // this same header.
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).end('Unauthorized');
    }

    try {
        const openSessions = await stripe.checkout.sessions.list({
            status: 'open',
            limit: 100,
        });

        const cutoff = Math.floor(Date.now() / 1000) - (5 * 60); // 5-minute abandonment window
        let expiredCount = 0;

        for (const session of openSessions.data) {
            if (session.created < cutoff) {
                await stripe.checkout.sessions.expire(session.id);
                expiredCount++;
            }
        }

        res.status(200).json({ message: `Expired ${expiredCount} abandoned checkout session(s).` });
    } catch (error) {
        console.error('Cron Error:', error);
        res.status(500).json({ error: error.message });
    }
}
