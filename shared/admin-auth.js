// Shared Supabase bootstrap + admin gate for admin.html. index.html has its own inline copy of
// the client bootstrap (it needs the full auth/account UI, not just an admin gate) -- this file
// exists so admin.html doesn't have to hand-copy that same setup.
//
// Same public anon key index.html already ships to every visitor -- it only works within
// whatever RLS policies exist in Postgres, so exposing it here is no different from exposing it
// there.
const SUPABASE_URL = 'https://qdwruisviyifpangaqrx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkd3J1aXN2aXlpZnBhbmdhcXJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0NzQxMDUsImV4cCI6MjA5OTA1MDEwNX0.AkRvjsv5B130EOaqMWEq4Egk5ZC9Yxg-B7pL57hSfCU';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// AdminAuth.init(): resolves once we know whether the current visitor is a signed-in admin.
// - Not signed in / not an admin -> redirects to '/' with a message, never renders admin.html's body.
// - Admin -> resolves { user, profile, accessToken } and reveals the page (body has
//   `visibility:hidden` by default in admin.html to avoid a flash of admin UI before this check
//   completes).
const AdminAuth = {
    async init() {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (!session) {
            window.location.href = '/?adminRedirect=signin';
            return null;
        }

        const { data: profile, error } = await supabaseClient
            .from('profiles')
            .select('is_admin, username')
            .eq('id', session.user.id)
            .single();

        if (error || !profile || !profile.is_admin) {
            window.location.href = '/?adminRedirect=denied';
            return null;
        }

        document.body.style.visibility = 'visible';
        return { user: session.user, profile, accessToken: session.access_token };
    },

    // Convenience for admin.html's fetch() calls to admin-only API routes.
    authHeader(accessToken) {
        return { Authorization: `Bearer ${accessToken}` };
    },

    async signOut() {
        await supabaseClient.auth.signOut();
        window.location.href = '/';
    },
};
