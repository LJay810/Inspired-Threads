const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { notifySupportMessage } = require('../lib/notify');
import { Redis } from '@upstash/redis';

const kv = Redis.fromEnv();
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    // Optional discriminator -- absent means "cancel this Stripe session", the one thing this
    // file has ever done. Folded the support-chat email trigger in here (rather than a new
    // api/*.js file) because this project is already at Vercel Hobby's 12-function cap, and this
    // is the only existing file with zero identity/auth checks of any kind -- the right posture
    // for something a GUEST (no login) needs to be able to trigger. See
    // sql/support_chat_schema.sql for the rest of the support chat feature.
    const action = req.body && req.body.action;

    if (action === 'notify_support_message') {
        return handleNotifySupportMessage(req, res);
    }

    try {
        const { sessionId } = req.body;
        if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        // Only expire it if it's still open — avoids errors if this somehow
        // gets called twice (e.g. the customer hits back, then refreshes the page).
        if (session.status === 'open') {
            await stripe.checkout.sessions.expire(sessionId);
        }

        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Cancel-session error:', error);
        // Fail quietly toward the customer — this is a background convenience call,
        // not something that should ever block or error out their browsing experience.
        res.status(200).json({ ok: false });
    }
}

// Never trusts the client's own claim of what the message said -- re-fetches the REAL row from
// Supabase via the service role first, same "never trust the client" discipline as
// api/checkout.js's discountChoice handling. Unlike the Stripe branch above, failures here
// return real error statuses rather than always-200 -- silently swallowing a broken notification
// pipeline would just mean support messages quietly stop reaching anyone.
async function handleNotifySupportMessage(req, res) {
    try {
        if (!supabaseAdmin) return res.status(500).json({ error: 'Server not configured.' });

        const { conversationId, messageId } = req.body;
        if (!conversationId || !messageId) {
            return res.status(400).json({ error: 'Missing conversationId/messageId' });
        }

        const { data: message, error: msgErr } = await supabaseAdmin
            .from('support_messages')
            .select('id, conversation_id, sender_type, sender_name, body, image_url')
            .eq('id', messageId)
            .eq('conversation_id', conversationId)
            .single();
        if (msgErr || !message) return res.status(404).json({ error: 'Message not found.' });

        // Only ever alert on a CUSTOMER message -- an admin's own reply obviously shouldn't
        // email the admin. Also silently no-ops rather than erroring, since a stale/duplicate
        // client-side call landing here for an admin message is expected, not a real failure.
        if (message.sender_type !== 'customer') return res.status(200).json({ ok: true, skipped: true });

        const { data: conversation } = await supabaseAdmin
            .from('support_conversations')
            .select('user_id')
            .eq('id', conversationId)
            .single();

        // One email per conversation per 5 minutes -- a chatty guest firing off several rapid
        // messages shouldn't spam the inbox once per message. First message in a burst always
        // gets through immediately (kv.set with nx returns true the first time, false after).
        const throttleKey = `support_notify_throttle_${conversationId}`;
        const shouldNotify = await kv.set(throttleKey, '1', { nx: true, ex: 300 });
        if (!shouldNotify) return res.status(200).json({ ok: true, throttled: true });

        await notifySupportMessage({
            conversationId,
            senderName: message.sender_name,
            isGuest: !(conversation && conversation.user_id),
            messagePreview: message.body || (message.image_url ? '📷 Image attached' : null),
        });

        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Support chat notify error:', error);
        res.status(500).json({ error: error.message });
    }
}
