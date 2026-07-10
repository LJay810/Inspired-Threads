-- Consolidated GRANT fixes.
--
-- These were originally discovered and applied one at a time, reactively, each time a
-- "permission denied" error actually showed up in production logs. This file exists purely
-- so a full rebuild doesn't have to rediscover the same errors one by one, in the same order,
-- the way they actually happened.
--
-- RUN ORDER MATTERS: run this file LAST, after both loyalty_schema.sql and
-- referral_reviews_schema.sql -- several lines below grant access on specific tables and
-- sequences (reviews, wishlists, purchases' id sequence) that only exist once those two files
-- have already created them.
--
-- Safe to re-run any time -- GRANT is idempotent by nature; granting something that's already
-- granted is a harmless no-op.

-- ============================================================================
-- 1. service_role -- used by webhook.js, checkout.js, submit-review.js, admin-restock.js,
--    and cron-birthday-coupons.js. Needs full access so it can legitimately bypass RLS for
--    server-side writes (award_loyalty, the purchases ledger, birthday coupon issuance, etc).
--
--    Original incident: "permission denied for table profiles" the very first time
--    cron-birthday-coupons.js ran -- turned out to be a missing table-level GRANT, unrelated
--    to RLS policies (which service_role bypasses anyway). Then again later, more narrowly,
--    as "permission denied for sequence purchases_id_seq" -- the table grant below doesn't
--    automatically cover the separate sequence object backing a bigserial primary key.
-- ============================================================================
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all routines in schema public to service_role;

-- So any table created AFTER this point auto-grants to service_role too, without needing
-- another one-off fix like the sequence incident above.
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;

-- ============================================================================
-- 2. authenticated / anon -- the browser's own two roles (anon key vs. a logged-in user's
--    JWT). RLS policies only ever get EVALUATED after a role has this baseline table-level
--    grant -- without it, every request silently fails with "permission denied for table X"
--    before RLS is even consulted, no matter how correct the RLS policies themselves are.
--    This is the exact bug hit twice: once on `reviews` (star ratings wouldn't load), then
--    again on `wishlists` (restock alerts silently never synced).
-- ============================================================================

-- reviews: public read (anyone can see star ratings/comments, logged in or not). Writes are
-- deliberately NOT granted here -- all inserts go through submit-review.js's service-role
-- verified-purchase check instead, never directly from the browser.
grant select on public.reviews to anon, authenticated;

-- wishlists: a logged-in shopper manages their own wishlist directly from index.html
-- (syncWishlistToSupabase). RLS's "auth.uid() = user_id" policies scope this correctly on
-- top of this baseline grant.
grant select, insert, delete on public.wishlists to authenticated;

-- profiles: logged-in shoppers already read/update their own row today (xp, badges,
-- birthday, referral fields, stock alert prefs, etc) without ever having hit this specific
-- error -- meaning this table likely already had a working grant from before this file
-- existed (probably part of however the table was originally bootstrapped). Included here
-- anyway for completeness, so a from-scratch rebuild on a brand new Supabase project doesn't
-- have to rely on that same lucky pre-existing configuration.
grant select, update on public.profiles to authenticated;

-- So any FUTURE table also gets baseline authenticated access automatically -- RLS still
-- decides what's actually visible/writable row by row; this only sets the floor beneath it.
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
