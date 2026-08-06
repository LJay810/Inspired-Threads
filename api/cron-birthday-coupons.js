const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { effectiveTierName, perksForTier, isAnniversaryDay } = require('../lib/loyalty');

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// One reusable Stripe Coupon per birthday discount percentage (10/15/20/25, one per tier),
// looked up-or-created on first use so nothing needs manual setup in the Stripe Dashboard.
async function ensureBirthdayCoupon(percentOff) {
    const id = `BIRTHDAY_${percentOff}`;
    try {
        return await stripe.coupons.retrieve(id);
    } catch (err) {
        if (err.code !== 'resource_missing') throw err;
        return stripe.coupons.create({
            id,
            percent_off: percentOff,
            duration: 'once',
            name: `Birthday ${percentOff}% Off`,
        });
    }
}

function randomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous-looking characters
    let code = 'BDAY-';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

export default async function handler(req, res) {
    // Same auth pattern as cron-expire.js: Vercel Cron sends this header automatically;
    // an external pinger needs to be configured to send it too.
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).end('Unauthorized');
    }

    try {
        const today = new Date();
        const todayMonth = today.getUTCMonth() + 1;
        const thisYear = today.getUTCFullYear();

        // Supabase's JS client can't filter on "month/day of a date column" directly, so pull
        // every profile with a birthday set and filter in JS. Fine at this project's scale;
        // revisit with a Postgres function if the customer list ever gets huge.
        const { data: profiles, error } = await supabaseAdmin
            .from('profiles')
            .select('id, tier_spend, grandfathered_tier, birthday, birthday_code_year')
            .not('birthday', 'is', null);
        if (error) throw error;

        let issuedCount = 0;

        for (const profile of profiles || []) {
            if (profile.birthday_code_year === thisYear) continue; // already issued this year

            // Month-only match (not the exact day) -- this fires once, the first time the cron
            // runs after entering a shopper's birthday month (normally day 1 of that month),
            // and the birthday_code_year guard above is what keeps it from firing again on every
            // later day of that same month. The code itself stays valid through the LAST day of
            // the birthday month (below), not a fixed 30-day window, so it works the entire
            // month no matter which day within it actually gets used to claim it.
            const bday = new Date(profile.birthday);
            if (bday.getUTCMonth() + 1 !== todayMonth) continue;

            const tierName = effectiveTierName(profile.tier_spend || 0, profile.grandfathered_tier);
            const percentOff = perksForTier(tierName).birthdayDiscountPct;
            const coupon = await ensureBirthdayCoupon(percentOff);

            // Last moment (23:59:59 UTC) of the birthday month, whatever day within it this
            // actually runs on -- Date.UTC's day-0 rollback trick: passing the 1-indexed
            // birthday month as the (0-indexed) month argument with day 0 lands on the last day
            // of the PREVIOUS 0-indexed month, which is exactly the birthday month itself.
            const endOfMonth = new Date(Date.UTC(thisYear, todayMonth, 0, 23, 59, 59));
            const expiresAtSeconds = Math.floor(endOfMonth.getTime() / 1000);
            const code = randomCode();

            // This SDK/API version nests the coupon reference under `promotion: { type:
            // 'coupon', coupon }` rather than a flat top-level `coupon` field (Stripe's newer
            // generalized Promotions schema, in case non-coupon promotion types are added
            // later) -- same fix already applied in api/admin-user.js's own promotionCodes.create.
            await stripe.promotionCodes.create({
                promotion: { type: 'coupon', coupon: coupon.id },
                code,
                max_redemptions: 1,
                expires_at: expiresAtSeconds,
            });

            const { error: updateErr } = await supabaseAdmin
                .from('profiles')
                .update({
                    birthday_code: code,
                    birthday_code_expires: new Date(expiresAtSeconds * 1000).toISOString(),
                    birthday_code_year: thisYear,
                })
                .eq('id', profile.id);
            if (updateErr) throw updateErr;

            issuedCount++;
        }

        // ANNUAL TIER RESET ---------------------------------------------------
        // Piggybacks this same daily cron slot rather than getting its own serverless
        // function -- this project was already at Vercel Hobby's 12-function cap.
        // Rolling 12-month tier qualification: once a year, on the exact day matching a
        // shopper's signup (see isAnniversaryDay in lib/loyalty.js), their tier_spend resets
        // to 0 and they requalify for their current tier through fresh spend -- lifetime
        // stats (total_spent, order_count, badges) are untouched, so nobody loses an
        // achievement they already earned. Also clears grandfathered_tier at the same
        // moment: that column is a one-cycle safety net from the XP->dollars migration, not a
        // standing exemption -- after someone's first reset under the new system, they're
        // judged purely on real tier_spend.
        //
        // Signup date lives on the auth user, not the profile row -- pull every account's
        // created_at in one paginated pass rather than a per-profile lookup.
        const createdAtById = new Map();
        for (let page = 1; page <= 5; page++) {
            const { data: userPage, error: usersErr } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
            if (usersErr) throw usersErr;
            for (const u of userPage.users || []) createdAtById.set(u.id, u.created_at);
            if (!userPage.users || userPage.users.length < 1000) break;
        }

        const { data: allProfiles, error: allProfilesErr } = await supabaseAdmin
            .from('profiles')
            .select('id, tier_spend, grandfathered_tier');
        if (allProfilesErr) throw allProfilesErr;

        let resetCount = 0;
        for (const profile of allProfiles || []) {
            const createdAt = createdAtById.get(profile.id);
            if (!createdAt || !isAnniversaryDay(createdAt)) continue;
            if (!(profile.tier_spend > 0) && !profile.grandfathered_tier) continue; // nothing to reset

            const { error: resetErr } = await supabaseAdmin
                .from('profiles')
                .update({ tier_spend: 0, grandfathered_tier: null })
                .eq('id', profile.id);
            if (resetErr) throw resetErr;

            resetCount++;
        }

        res.status(200).json({
            message: `Issued ${issuedCount} birthday coupon(s). Reset ${resetCount} profile(s) for annual tier requalification.`,
        });
    } catch (error) {
        console.error('Birthday/tier-reset cron error:', error);
        res.status(500).json({ error: error.message });
    }
}