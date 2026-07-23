const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { requireAdmin } = require('../lib/require-admin');
const { TIERS } = require('../lib/loyalty');

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
                .select('id, username, badges, order_count, total_spent, tier_spend, grandfathered_tier, referral_count, is_admin, hide_from_leaderboard, credit_balance')
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
            const { userId, total_spent, tier_spend, badges, is_admin, hide_from_leaderboard, grandfathered_tier, credit_balance } = req.body;
            if (!userId) return res.status(400).json({ error: 'Missing userId.' });

            const updateFields = {};
            if (total_spent !== undefined) {
                const totalSpentNum = parseFloat(total_spent);
                if (!Number.isFinite(totalSpentNum) || totalSpentNum < 0) {
                    return res.status(400).json({ error: 'Invalid total_spent value.' });
                }
                updateFields.total_spent = totalSpentNum;
            }
            if (credit_balance !== undefined) {
                // Manual Crew Cash grant/adjustment -- the only way this balance changes today
                // (see sql/crew_cash_schema.sql; spent automatically at checkout via use_crew_cash).
                const creditBalanceNum = parseFloat(credit_balance);
                if (!Number.isFinite(creditBalanceNum) || creditBalanceNum < 0) {
                    return res.status(400).json({ error: 'Invalid credit_balance value.' });
                }
                updateFields.credit_balance = creditBalanceNum;
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
            if (grandfathered_tier !== undefined) {
                // '' / null clears the floor entirely (tier then comes purely from tier_spend).
                // Otherwise must be a real tier name -- this is a FLOOR (see effectiveTierName
                // in lib/loyalty.js), so it can only raise what a profile displays as, never
                // lower it below what their real tier_spend already earns.
                const floorName = grandfathered_tier || null;
                if (floorName !== null && !TIERS.some(t => t.name === floorName)) {
                    return res.status(400).json({ error: `Invalid grandfathered_tier value. Must be one of: ${TIERS.map(t => t.name).join(', ')}, or empty to clear.` });
                }
                updateFields.grandfathered_tier = floorName;
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

        // ===================== PROMO CODES =====================
        // Folded into this file rather than a new api/admin-*.js one -- this project is already
        // at Vercel Hobby's 12-serverless-function cap (see the comment in api/products.js).
        // A Stripe Promotion Code is always backed by a Coupon (the actual discount terms);
        // since each promo code created here gets its own fresh Coupon (never shared/reused,
        // unlike the standing-discount coupons in checkout.js), the two are always created and
        // read together as a single unit from the admin's point of view.

        if (action === 'list_promo_codes') {
            // Coupon details live under promotion.coupon in this API schema, not a flat top-level
            // `coupon` field (see the create_promo_code comment below for why).
            const promoCodes = await stripe.promotionCodes.list({ limit: 100, expand: ['data.promotion.coupon'] });
            return res.status(200).json({ promoCodes: promoCodes.data });
        }

        if (action === 'create_promo_code') {
            const {
                code, discountType, percentOff, amountOff, duration, durationInMonths,
                maxRedemptions, expiresAt, minOrderAmount, firstTimeOnly,
            } = req.body;

            const trimmedCode = String(code || '').trim().toUpperCase();
            if (!trimmedCode) return res.status(400).json({ error: 'Missing promo code.' });
            if (!['percent', 'amount'].includes(discountType)) {
                return res.status(400).json({ error: 'discountType must be "percent" or "amount".' });
            }
            if (!['once', 'repeating', 'forever'].includes(duration)) {
                return res.status(400).json({ error: 'duration must be "once", "repeating", or "forever".' });
            }

            const couponParams = { duration, name: trimmedCode };
            if (discountType === 'percent') {
                const pct = parseFloat(percentOff);
                if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
                    return res.status(400).json({ error: 'percentOff must be between 1 and 100.' });
                }
                couponParams.percent_off = pct;
            } else {
                const amt = parseFloat(amountOff);
                if (!Number.isFinite(amt) || amt <= 0) {
                    return res.status(400).json({ error: 'amountOff must be a positive dollar amount.' });
                }
                couponParams.amount_off = Math.round(amt * 100);
                couponParams.currency = 'usd';
            }
            if (duration === 'repeating') {
                const months = parseInt(durationInMonths, 10);
                if (!Number.isInteger(months) || months <= 0) {
                    return res.status(400).json({ error: 'durationInMonths is required (positive whole number) when duration is "repeating".' });
                }
                couponParams.duration_in_months = months;
            }

            const promoParams = { code: trimmedCode, active: true };
            if (maxRedemptions !== undefined && maxRedemptions !== '' && maxRedemptions !== null) {
                const maxR = parseInt(maxRedemptions, 10);
                if (!Number.isInteger(maxR) || maxR <= 0) {
                    return res.status(400).json({ error: 'maxRedemptions must be a positive whole number.' });
                }
                promoParams.max_redemptions = maxR;
            }
            if (expiresAt) {
                const expiresTs = Math.floor(new Date(expiresAt).getTime() / 1000);
                if (!Number.isFinite(expiresTs)) return res.status(400).json({ error: 'Invalid expiresAt date.' });
                promoParams.expires_at = expiresTs;
            }
            const restrictions = {};
            if (minOrderAmount !== undefined && minOrderAmount !== '' && minOrderAmount !== null) {
                const minAmt = parseFloat(minOrderAmount);
                if (!Number.isFinite(minAmt) || minAmt <= 0) {
                    return res.status(400).json({ error: 'minOrderAmount must be a positive dollar amount.' });
                }
                restrictions.minimum_amount = Math.round(minAmt * 100);
                restrictions.minimum_amount_currency = 'usd';
            }
            if (firstTimeOnly) restrictions.first_time_transaction = true;
            if (Object.keys(restrictions).length > 0) promoParams.restrictions = restrictions;

            // Coupon first, then the customer-facing code pointing at it -- if the code itself
            // is invalid/taken, Stripe rejects promotionCodes.create and we're left with an
            // unused (harmless) coupon rather than a promo code with no backing discount.
            // NOTE: this SDK/API version nests the coupon reference under `promotion: { type:
            // 'coupon', coupon }` rather than a flat top-level `coupon` field (Stripe's newer
            // generalized Promotions schema, in case non-coupon promotion types are added later).
            const coupon = await stripe.coupons.create(couponParams);
            promoParams.promotion = { type: 'coupon', coupon: coupon.id };
            const promotionCode = await stripe.promotionCodes.create(promoParams);

            return res.status(200).json({ ok: true, promotionCode, coupon });
        }

        if (action === 'deactivate_promo_code') {
            const { promotionCodeId } = req.body;
            if (!promotionCodeId) return res.status(400).json({ error: 'Missing promotionCodeId.' });
            const promotionCode = await stripe.promotionCodes.update(promotionCodeId, { active: false });
            return res.status(200).json({ ok: true, promotionCode });
        }

        return res.status(400).json({ error: 'Unknown action.' });
    } catch (error) {
        console.error('Admin user endpoint error:', error);
        res.status(500).json({ error: error.message });
    }
}