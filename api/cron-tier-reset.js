const { createClient } = require('@supabase/supabase-js');
const { isAnniversaryDay } = require('../lib/loyalty');

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Rolling 12-month tier qualification: once a year, on the exact day matching their signup
// (see isAnniversaryDay in lib/loyalty.js), a shopper's tier_spend resets to 0 and they
// requalify for their current tier through fresh spend -- lifetime stats (total_spent,
// order_count, badges) are untouched, so nobody loses an achievement they already earned.
// Also clears grandfathered_tier at the same moment: that column is a one-cycle safety net
// from the XP->dollars migration (see sql/loyalty_schema.sql), not a standing exemption --
// after someone's first reset under the new system, they're judged purely on real tier_spend.
export default async function handler(req, res) {
    // Same auth pattern as cron-expire.js / cron-birthday-coupons.js: Vercel Cron sends this
    // header automatically; an external pinger needs to be configured to send it too.
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).end('Unauthorized');
    }

    try {
        // Signup date lives on the auth user, not the profile row (same lookup this repo
        // already does for the anniversary badge in webhook.js) -- pull every account's
        // created_at in one paginated pass rather than a per-profile lookup.
        const createdAtById = new Map();
        for (let page = 1; page <= 5; page++) {
            const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
            if (error) throw error;
            for (const u of data.users || []) createdAtById.set(u.id, u.created_at);
            if (!data.users || data.users.length < 1000) break;
        }

        const { data: profiles, error: profilesErr } = await supabaseAdmin
            .from('profiles')
            .select('id, tier_spend, grandfathered_tier');
        if (profilesErr) throw profilesErr;

        let resetCount = 0;

        for (const profile of profiles || []) {
            const createdAt = createdAtById.get(profile.id);
            if (!createdAt || !isAnniversaryDay(createdAt)) continue;
            if (!(profile.tier_spend > 0) && !profile.grandfathered_tier) continue; // nothing to reset

            const { error: updateErr } = await supabaseAdmin
                .from('profiles')
                .update({ tier_spend: 0, grandfathered_tier: null })
                .eq('id', profile.id);
            if (updateErr) throw updateErr;

            resetCount++;
        }

        res.status(200).json({ message: `Reset ${resetCount} profile(s) for their annual tier requalification.` });
    } catch (error) {
        console.error('Tier reset cron error:', error);
        res.status(500).json({ error: error.message });
    }
}
