const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // Identify the shopper from their own Supabase session token (sent by the client),
        // rather than trusting a user id in the request body -- a body value could be spoofed
        // to submit a review as someone else.
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'You need to be signed in to leave a review.' });

        const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
        if (userErr || !userData || !userData.user) {
            return res.status(401).json({ error: 'Your session has expired -- please sign in again.' });
        }
        const userId = userData.user.id;

        const { productId, rating, comment } = req.body;
        const ratingNum = parseInt(rating, 10);
        if (!productId || !Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            return res.status(400).json({ error: 'Missing product or an invalid rating (must be 1-5).' });
        }

        // VERIFIED-PURCHASE GATE: this is the whole reason this is a server endpoint instead
        // of a direct client insert -- a browser could claim anything, but the purchases
        // table only ever gets written by webhook.js after a real Stripe payment succeeds.
        const { data: purchase } = await supabaseAdmin
            .from('purchases')
            .select('id')
            .eq('user_id', userId)
            .eq('product_id', productId)
            .limit(1)
            .maybeSingle();
        if (!purchase) {
            return res.status(403).json({ error: "You can only review products you've purchased." });
        }

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('username')
            .eq('id', userId)
            .single();

        const { error: insertErr } = await supabaseAdmin
            .from('reviews')
            .insert({
                product_id: productId,
                user_id: userId,
                username: (profile && profile.username) || 'Verified Buyer',
                rating: ratingNum,
                comment: (comment || '').trim().slice(0, 1000),
            });

        if (insertErr) {
            if (insertErr.code === '23505') { // unique(product_id, user_id) violation
                return res.status(409).json({ error: "You've already reviewed this product." });
            }
            throw insertErr;
        }

        // First-ever review from this shopper: award the 'reviewer' badge.
        const { count } = await supabaseAdmin
            .from('reviews')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId);
        if (count === 1) {
            await supabaseAdmin.rpc('add_badges', { p_user_id: userId, p_new_badges: ['reviewer'] });
        }

        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Submit review error:', error);
        res.status(500).json({ error: error.message });
    }
}