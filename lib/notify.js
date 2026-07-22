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

    // imageUrl comes from the product's own images[0] in Supabase Storage (catalog moved off
    // Stripe -- see api/products.js). Unlike the old Stripe-hosted era, this DOES count against
    // Supabase Cached Egress every time a recipient's email client renders it, same as any other
    // storefront image -- worth compressing on upload for exactly that reason.
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

// Alerts whoever's packing orders (fixed address, not per-shopper preference like restock
// alerts) whenever an order needs something physical tucked in -- a spin-wheel prize (pop
// socket / custom pen / mystery gift) or the loyalty free gift perk. Called from
// webhook.js's checkout.session.completed handler, once per completed order, only when at
// least one such item actually applies.
async function notifyPackingAlert({ username, email, sessionId, items }) {
    if (!process.env.RESEND_API_KEY) {
        console.warn('RESEND_API_KEY not set -- skipping packing alert email');
        return;
    }
    if (!items || items.length === 0) return;

    const fromAddress = process.env.RESEND_FROM_EMAIL || 'Inspired Threads <alerts@inspiredthreads.com>';
    const toAddress = 'inspiredthreadsgt@gmail.com';
    // Live-mode dashboard deep link -- opens straight to this exact order.
    const orderUrl = `https://dashboard.stripe.com/checkout/sessions/${sessionId}`;
    const safeUsername = escapeForEmailHtml(username || 'Customer');
    const safeEmail = escapeForEmailHtml(email || 'unknown');
    const itemsText = items.join(', ');

    const html = `
        <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto;">
            <div style="background: #ff007f; padding: 24px; text-align: center; border-radius: 12px 12px 0 0;">
                <div style="font-size: 32px; margin-bottom: 6px;">📦</div>
                <h1 style="margin: 0; color: #fff; font-size: 18px; letter-spacing: 0.08em; text-transform: uppercase; font-family: monospace;">Packing Alert</h1>
            </div>
            <div style="border: 1px solid #eee; border-top: none; border-radius: 0 0 12px 12px; padding: 28px; background: #fff;">
                <p style="color: #333; font-size: 15px; line-height: 1.6; margin: 0 0 20px;">A new order just came in that needs something extra tucked in before it ships!</p>

                <div style="background: #fdf2f8; border-left: 3px solid #ff007f; padding: 16px 20px; margin-bottom: 22px; border-radius: 6px;">
                    <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #ff007f; font-weight: 700; margin-bottom: 8px;">Include With This Order</div>
                    <ul style="margin: 0; padding-left: 20px; color: #333; font-size: 15px; line-height: 1.8;">
                        ${items.map(item => `<li>${escapeForEmailHtml(item)}</li>`).join('')}
                    </ul>
                </div>

                <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #333;">
                    <tr><td style="padding: 6px 0; color: #888;">Customer</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${safeUsername}</td></tr>
                    <tr><td style="padding: 6px 0; color: #888;">Email</td><td style="padding: 6px 0; text-align: right;">${safeEmail}</td></tr>
                    <tr><td style="padding: 6px 0; color: #888;">Order Ref</td><td style="padding: 6px 0; text-align: right; font-family: monospace; font-size: 12px;">${escapeForEmailHtml(sessionId)}</td></tr>
                </table>

                <a href="${orderUrl}" style="display: block; box-sizing: border-box; margin-top: 22px; padding: 13px 26px; background: #ff007f; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px; text-align: center;">View Order in Stripe →</a>
            </div>
        </div>
    `;
    const text = `Packing alert! Include: ${itemsText}. Customer: ${username} (${email}). Order ref: ${sessionId}. View: ${orderUrl}`;

    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: fromAddress,
                to: toAddress,
                subject: `📦 Packing Alert — ${itemsText}`,
                html,
                text,
            }),
        });
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Resend API error ${response.status}: ${errText}`);
        }
    } catch (err) {
        console.error('Failed to send packing alert email via Resend:', err.message);
    }
}

// Tells whoever produces the DTF designs (fixed address, same as notifyPackingAlert -- not a
// per-shopper preference) that a sold-out design was just resurrected via a pre-order payment,
// so they know what to print. Called from webhook.js's checkout.session.completed handler, only
// when resurrect_product() actually won the race for this product (see lib/graveyard.js /
// sql/graveyard_resurrection_schema.sql).
async function notifyResurrection({ productName, imageUrl, categoryLabel, sessionId }) {
    if (!process.env.RESEND_API_KEY) {
        console.warn('RESEND_API_KEY not set -- skipping resurrection email');
        return;
    }

    const fromAddress = process.env.RESEND_FROM_EMAIL || 'Inspired Threads <alerts@inspiredthreads.com>';
    const toAddress = 'inspiredthreadsgt@gmail.com';
    const orderUrl = `https://dashboard.stripe.com/checkout/sessions/${sessionId}`;
    const safeName = escapeForEmailHtml(productName || 'Untitled design');
    const safeCategory = escapeForEmailHtml(categoryLabel || 'Unknown category');
    const imageHtml = imageUrl
        ? `<img src="${imageUrl}" alt="${safeName}" style="max-width:100%; border-radius:12px; margin-bottom:20px; display:block;">`
        : '';

    const html = `
        <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto;">
            <div style="background: #7c3aed; padding: 24px; text-align: center; border-radius: 12px 12px 0 0;">
                <div style="font-size: 32px; margin-bottom: 6px;">🪦✨</div>
                <h1 style="margin: 0; color: #fff; font-size: 18px; letter-spacing: 0.08em; text-transform: uppercase; font-family: monospace;">A Design Was Resurrected</h1>
            </div>
            <div style="border: 1px solid #eee; border-top: none; border-radius: 0 0 12px 12px; padding: 28px; background: #fff;">
                <p style="color: #333; font-size: 15px; line-height: 1.6; margin: 0 0 20px;">Someone just paid to bring this sold-out DTF design back from the Graveyard -- it's back in the shop and needs printing.</p>

                ${imageHtml}

                <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #333; margin-top: 10px;">
                    <tr><td style="padding: 6px 0; color: #888;">Design</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${safeName}</td></tr>
                    <tr><td style="padding: 6px 0; color: #888;">Now filed under</td><td style="padding: 6px 0; text-align: right;">${safeCategory}</td></tr>
                    <tr><td style="padding: 6px 0; color: #888;">Order Ref</td><td style="padding: 6px 0; text-align: right; font-family: monospace; font-size: 12px;">${escapeForEmailHtml(sessionId)}</td></tr>
                </table>

                <a href="${orderUrl}" style="display: block; box-sizing: border-box; margin-top: 22px; padding: 13px 26px; background: #7c3aed; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px; text-align: center;">View Order in Stripe →</a>
            </div>
        </div>
    `;
    const text = `"${productName}" was just resurrected from the Graveyard! Now filed under: ${categoryLabel}. Order ref: ${sessionId}. View: ${orderUrl}`;

    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: fromAddress,
                to: toAddress,
                subject: `🪦✨ Resurrected — ${productName}`,
                html,
                text,
            }),
        });
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Resend API error ${response.status}: ${errText}`);
        }
    } catch (err) {
        console.error('Failed to send resurrection email via Resend:', err.message);
    }
}

module.exports = { notifyRestock, notifyPackingAlert, notifyResurrection };