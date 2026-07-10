// Restock notification dispatch. Targets only shoppers who (a) have alerts enabled AND
// (b) actually have this specific product on their wishlist -- see the wishlists table in
// referral_reviews_schema.sql, which mirrors just the product ids from each logged-in
// shopper's localStorage wishlist for exactly this purpose.
//
// TODO: sendSms is still a stub (just console.logs) -- only email (Resend) was requested.
// Revisit if phone alerts are needed later (e.g. via Twilio).

async function notifyRestock(supabaseAdmin, productId, productName) {
    if (!supabaseAdmin) return;
    try {
        const { data: wishlistRows, error: wishlistErr } = await supabaseAdmin
            .from('wishlists')
            .select('user_id')
            .eq('product_id', productId);
        if (wishlistErr) throw wishlistErr;

        const userIds = [...new Set((wishlistRows || []).map(w => w.user_id))];
        if (userIds.length === 0) return; // nobody wishlisted this -- nothing to do

        const { data: subscribers, error: subErr } = await supabaseAdmin
            .from('profiles')
            .select('id, stock_alert_method, stock_alert_phone')
            .in('id', userIds)
            .eq('stock_alerts_enabled', true);
        if (subErr) throw subErr;

        for (const sub of subscribers || []) {
            const message = `"${productName}" is back in stock at Inspired Threads!`;
            if (sub.stock_alert_method === 'phone' && sub.stock_alert_phone) {
                await sendSms(sub.stock_alert_phone, message);
            } else {
                const { data: userData } = await supabaseAdmin.auth.admin.getUserById(sub.id);
                const email = userData && userData.user && userData.user.email;
                if (email) await sendEmail(email, message);
            }
        }
    } catch (err) {
        // Never let a notification failure take down the webhook that triggered it.
        console.error('Restock notification dispatch failed:', err.message);
    }
}

async function sendEmail(to, message) {
    if (!process.env.RESEND_API_KEY) {
        console.warn('RESEND_API_KEY not set -- skipping restock email to', to);
        return;
    }
    // Must be an address on a domain verified in your Resend account (or their
    // onboarding@resend.dev test address, which only delivers to your own account email).
    const fromAddress = process.env.RESEND_FROM_EMAIL || 'Inspired Threads <alerts@inspiredthreads.com>';

    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: fromAddress,
                to,
                subject: 'Back in stock! 🎉',
                text: message,
            }),
        });
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Resend API error ${response.status}: ${errText}`);
        }
    } catch (err) {
        console.error('Failed to send restock email via Resend:', err.message);
    }
}

async function sendSms(to, message) {
    // Not wired up yet -- only email (Resend) was requested. Revisit if/when phone alerts
    // are needed (e.g. via Twilio).
    console.log(`[stub sms -- no provider wired up yet] to=${to}: ${message}`);
}

module.exports = { notifyRestock }; 