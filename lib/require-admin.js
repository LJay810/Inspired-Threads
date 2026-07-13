const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// The real security boundary for every admin-only endpoint. Any client-side "is this user an
// admin" check (hiding a button, redirecting a page) is UX only -- this server-side check,
// re-run on every request against the caller's own bearer token, is what actually stops a
// non-admin from calling these endpoints directly. Extracted from api/admin-user.js, which
// previously had the only copy of this; api/admin-restock.js used to inline a duplicate.
async function requireAdmin(req) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return { error: 'Not signed in.', status: 401 };

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData || !userData.user) {
        return { error: 'Your session has expired -- please sign in again.', status: 401 };
    }

    const { data: profile } = await supabaseAdmin.from('profiles').select('is_admin, username').eq('id', userData.user.id).single();
    if (!profile || !profile.is_admin) {
        return { error: 'Not authorized.', status: 403 };
    }
    return { callerId: userData.user.id, username: profile.username };
}

module.exports = { requireAdmin };
