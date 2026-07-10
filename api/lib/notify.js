// Restock notification dispatch. Targets only shoppers who (a) have alerts enabled AND
// (b) actually have this specific product on their wishlist -- see the wishlists table in
// referral_reviews_schema.sql, which mirrors just the product ids from each logged-in
// shopper's localStorage wishlist for exactly this purpose.
//
// TODO: sendSms is still a stub (just console.logs) -- only email (Resend) was requested.
// Revisit if phone alerts are needed later (e.g. via Twilio).

async function notifyRestock(supabaseAdmin, productId, productName, productImageUrl) {
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
            if (sub.stock_alert_method === 'phone' && sub.stock_alert_phone) {
                await sendSms(sub.stock_alert_phone, `"${productName}" is back in stock at Inspired Threads!`);
            } else {
                const { data: userData } = await supabaseAdmin.auth.admin.getUserById(sub.id);
                const email = userData && userData.user && userData.user.email;
                if (email) await sendEmail(email, productName, productImageUrl);
            }
        }
    } catch (err) {
        // Never let a notification failure take down the webhook that triggered it.
        console.error('Restock notification dispatch failed:', err.message);
    }
}

function escapeForEmailHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendEmail(to, productName, imageUrl) {
    if (!process.env.RESEND_API_KEY) {
        console.warn('RESEND_API_KEY not set -- skipping restock email to', to);
        return;
    }
    // Must be an address on a domain verified in your Resend account (or their
    // onboarding@resend.dev test address, which only delivers to your own account email).
    const fromAddress = process.env.RESEND_FROM_EMAIL || 'Inspired Threads <alerts@inspiredthreads.com>';
    const shopUrl = process.env.SHOP_URL || 'https://inspiredthreads.shop';
    const safeName = escapeForEmailHtml(productName);

    // imageUrl comes straight from Stripe's own product.images -- Stripe hosts those
    // publicly already, so there's nothing extra to upload or host ourselves.
    const imageHtml = imageUrl
        ? `<img src="${imageUrl}" alt="${safeName}" style="max-width:100%; border-radius:12px; margin-bottom:20px; display:block;">`
        : '';

    const html = `
        <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; text-align: center;">
            ${imageHtml}
            <h2 style="margin: 0 0 10px; color: #111;">Back in stock! 🎉</h2>
            <p style="color: #555; font-size: 15px; line-height: 1.5;">"${safeName}" just came back in stock at Inspired Threads.</p>
            <a href="${shopUrl}" style="display:inline-block; margin-top:16px; padding:12px 28px; background:#ff007f; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">Shop Now</a>
        </div>
    `;
    // Plain-text fallback for clients that don't render HTML (or block images) -- Resend
    // sends both parts in the same email, the recipient's client picks whichever it supports.
    const text = `"${productName}" is back in stock at Inspired Threads! Shop now: ${shopUrl}`;

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
                html,
                text,
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