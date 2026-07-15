const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { requireAdmin } = require('../lib/require-admin');

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const auth = await requireAdmin(req);
        if (auth.error) return res.status(auth.status).json({ error: auth.error });

        const { action } = req.body;

        if (action === 'search') {
            const query = (req.body.query || '').trim();
            if (!query) return res.status(400).json({ error: 'Missing search query.' });

            let idsWithEmail = []; // [{ id, email }] -- only populated for the email-search path

            if (query.includes('@')) {
                // Email search: paginate through Auth's user list looking for a match. Fine at
                // this shop's scale -- the Admin API has no direct "search by email" filter, so
                // this is the correct approach without adding a duplicate email column anywhere.
                const lowerQuery = query.toLowerCase();
                for (let page = 1; page <= 5; page++) {
                    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
                    if (error) throw error;
                    const found = (data.users || []).filter(u => u.email && u.email.toLowerCase().includes(lowerQuery));
                    idsWithEmail.push(...found.map(u => ({ id: u.id, email: u.email })));
                    if (!data.users || data.users.length < 1000 || idsWithEmail.length >= 20) break;
                }
            } else {
                // Username search
                const { data: profiles, error } = await supabaseAdmin
                    .from('profiles')
                    .select('id')
                    .ilike('username', `%${query}%`)
                    .limit(20);
                if (error) throw error;
                idsWithEmail = (profiles || []).map(p => ({ id: p.id, email: null }));
            }

            if (idsWithEmail.length === 0) return res.status(200).json({ results: [] });

            const ids = idsWithEmail.map(m => m.id);
            const { data: fullProfiles, error: profErr } = await supabaseAdmin
                .from('profiles')
                .select('id, username, badges, order_count, total_spent, tier_spend, grandfathered_tier, referral_count, is_admin, hide_from_leaderboard')
                .in('id', ids);
            if (profErr) throw profErr;

            // Fill in email for username-search results (one lookup each -- fine at this scale).
            const results = await Promise.all((fullProfiles || []).map(async (p) => {
                const known = idsWithEmail.find(m => m.id === p.id);
                let email = known && known.email;
                if (!email) {
                    const { data: userData } = await supabaseAdmin.auth.admin.getUserById(p.id);
                    email = (userData && userData.user && userData.user.email) || null;
                }
                return { ...p, email };
            }));

            return res.status(200).json({ results });
        }

        if (action === 'update') {
            const { userId, total_spent, tier_spend, badges, is_admin, hide_from_leaderboard } = req.body;
            if (!userId) return res.status(400).json({ error: 'Missing userId.' });

            const updateFields = {};
            if (total_spent !== undefined) {
                const totalSpentNum = parseFloat(total_spent);
                if (!Number.isFinite(totalSpentNum) || totalSpentNum < 0) {
                    return res.status(400).json({ error: 'Invalid total_spent value.' });
                }
                updateFields.total_spent = totalSpentNum;
            }
            if (tier_spend !== undefined) {
                const tierSpendNum = parseFloat(tier_spend);
                if (!Number.isFinite(tierSpendNum) || tierSpendNum < 0) {
                    return res.status(400).json({ error: 'Invalid tier_spend value.' });
                }
                updateFields.tier_spend = tierSpendNum;
            }
            if (badges !== undefined) {
                if (!Array.isArray(badges)) return res.status(400).json({ error: 'badges must be an array.' });
                updateFields.badges = badges;
            }
            if (is_admin !== undefined) {
                updateFields.is_admin = !!is_admin;
            }
            if (hide_from_leaderboard !== undefined) {
                updateFields.hide_from_leaderboard = !!hide_from_leaderboard;
            }
            if (Object.keys(updateFields).length === 0) {
                return res.status(400).json({ error: 'Nothing to update.' });
            }

            const { error: updateErr } = await supabaseAdmin.from('profiles').update(updateFields).eq('id', userId);
            if (updateErr) throw updateErr;

            return res.status(200).json({ ok: true });
        }

        if (action === 'list_pending_reviews') {
            const { data: pending, error } = await supabaseAdmin
                .from('site_reviews')
                .select('id, user_id, username, rating, comment, photo_url, created_at')
                .eq('status', 'pending')
                .order('created_at', { ascending: true });
            if (error) throw error;
            return res.status(200).json({ pending: pending || [] });
        }

        if (action === 'moderate_review') {
            const { reviewId, decision } = req.body;
            if (!reviewId || !['approve', 'reject'].includes(decision)) {
                return res.status(400).json({ error: 'Missing or invalid reviewId/decision.' });
            }
            const newStatus = decision === 'approve' ? 'approved' : 'rejected';

            const { data: reviewRow, error: fetchErr } = await supabaseAdmin
                .from('site_reviews').select('user_id').eq('id', reviewId).single();
            if (fetchErr) throw fetchErr;

            const { error: updateErr } = await supabaseAdmin
                .from('site_reviews')
                .update({ status: newStatus, reviewed_by: auth.callerId, reviewed_at: new Date().toISOString() })
                .eq('id', reviewId);
            if (updateErr) throw updateErr;

            // Award the 'reviewer' badge on approval only -- a rejected submission shouldn't earn it.
            if (decision === 'approve' && reviewRow) {
                const { data: currentProfile } = await supabaseAdmin.from('profiles').select('badges').eq('id', reviewRow.user_id).single();
                if (currentProfile && !(currentProfile.badges || []).includes('reviewer')) {
                    await supabaseAdmin.rpc('add_badges', { p_user_id: reviewRow.user_id, p_new_badges: ['reviewer'] });
                }
            }

            return res.status(200).json({ ok: true });
        }

        return res.status(400).json({ error: 'Unknown action.' });
    } catch (error) {
        console.error('Admin user endpoint error:', error);
        res.status(500).json({ error: error.message });
    }
}