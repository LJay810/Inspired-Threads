const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Reworked from the old per-product/verified-purchase system into a general site review:
// one per account, submitted with an optional photo (already uploaded client-side straight to
// Supabase Storage -- this endpoint just receives the resulting URL), sits pending until an
// admin approves it via admin-user.js. Trust model swapped from "did you buy this" to
// "did an admin look at it," since these are no longer tied to a specific purchased product.
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'You need to be signed in to submit a review.' });

        const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
        if (userErr || !userData || !userData.user) {
            return res.status(401).json({ error: 'Your session has expired -- please sign in again.' });
        }
        const userId = userData.user.id;

        const { rating, comment, photoUrl } = req.body;
        const ratingNum = parseInt(rating, 10);
        if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            return res.status(400).json({ error: 'Invalid rating (must be 1-5).' });
        }
        const commentText = (comment || '').trim();
        if (!commentText) {
            return res.status(400).json({ error: 'Please write a short review.' });
        }
        if (commentText.length > 1000) {
            return res.status(400).json({ error: 'Review is too long (max 1000 characters).' });
        }

        // photoUrl, if present, must point into THIS user's own storage folder -- the DB trigger
        // on profiles.avatar_url does the equivalent check for avatars; this is that same idea
        // applied here, since review photos don't have a trigger of their own (site_reviews rows
        // are only ever written server-side, so there's nothing for a trigger to guard against
        // that this check doesn't already cover).
        let safePhotoUrl = null;
        if (photoUrl && typeof photoUrl === 'string' && photoUrl.includes(`/review-photos/${userId}/`)) {
            safePhotoUrl = photoUrl;
        }

        const { data: profile } = await supabaseAdmin.from('profiles').select('username').eq('id', userId).single();

        // One review per person -- resubmitting (e.g. after a rejection) updates the existing
        // row and resets it back to pending, rather than creating a duplicate.
        const { error: upsertErr } = await supabaseAdmin
            .from('site_reviews')
            .upsert({
                user_id: userId,
                username: (profile && profile.username) || 'Customer',
                rating: ratingNum,
                comment: commentText,
                photo_url: safePhotoUrl,
                status: 'pending',
                reviewed_by: null,
                reviewed_at: null,
            }, { onConflict: 'user_id' });
        if (upsertErr) throw upsertErr;

        // NOTE: the 'reviewer' badge is intentionally NOT awarded here -- it's granted on
        // approval instead (see admin-user.js's moderate_review action), since a rejected
        // submission shouldn't earn it.

        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Submit review error:', error);
        res.status(500).json({ error: error.message });
    }
}