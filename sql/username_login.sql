-- Lets a shopper log in with their username instead of their email. Supabase Auth's
-- signInWithPassword() only ever accepts an email -- there's no first-class username login --
-- so the login form resolves a typed username to its email via this RPC first, then calls
-- signInWithPassword with the resolved email exactly as if they'd typed it themselves.
--
-- Usernames are already public-facing on this site (Leaderboard, Reviews, review author names),
-- so mapping a known username to its email isn't a new information leak the way it would be on
-- a site where usernames are private -- same reasoning already accepted for lookup_referrer_id
-- in referral_reviews_schema.sql. Still narrow on purpose: returns ONLY the email for an EXACT
-- (now case-insensitive) username match, nothing else about that profile. Safe to run more than
-- once.
--
-- Case-insensitive uniqueness FIRST: the `profiles.username` column itself was created directly
-- in the live Supabase project (never in this repo's source-controlled schema), so whether it
-- already had a case-sensitive-only UNIQUE constraint can't be confirmed from code alone. Making
-- the login lookup below match case-insensitively without this index first would be unsafe --
-- if two accounts ever existed differing only by case (e.g. "JohnDoe" and "johndoe"), the
-- `limit 1` below would arbitrarily resolve to WHICHEVER one Postgres happens to return first,
-- silently letting one person's login attempt resolve to a stranger's account. This index makes
-- that scenario impossible going forward (Postgres enforces it at the database level for every
-- future signup too, not just this lookup) -- but if any such duplicate already exists in the
-- live data, this exact statement will fail with a duplicate-key error instead of applying
-- silently. That failure is the safety check: if it fires, resolve the naming conflict manually
-- (rename one of the two accounts) before re-running this file and enabling case-insensitive
-- login below.
create unique index if not exists profiles_username_lower_idx on public.profiles (lower(username));

create or replace function public.lookup_email_by_username(p_username text)
returns text
language sql
security definer
set search_path = public
as $$
  select au.email
  from auth.users au
  join public.profiles p on p.id = au.id
  where lower(p.username) = lower(p_username)
  limit 1;
$$;

-- Must be callable while signed OUT (that's the whole point -- resolving the identifier is
-- step one of logging in), so anon gets this alongside authenticated.
grant execute on function public.lookup_email_by_username(text) to anon, authenticated;
