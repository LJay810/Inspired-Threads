-- Lets a shopper log in with their username instead of their email. Supabase Auth's
-- signInWithPassword() only ever accepts an email -- there's no first-class username login --
-- so the login form resolves a typed username to its email via this RPC first, then calls
-- signInWithPassword with the resolved email exactly as if they'd typed it themselves.
--
-- Usernames are already public-facing on this site (Leaderboard, Reviews, review author names),
-- so mapping a known username to its email isn't a new information leak the way it would be on
-- a site where usernames are private -- same reasoning already accepted for lookup_referrer_id
-- in referral_reviews_schema.sql. Still narrow on purpose: returns ONLY the email for an EXACT
-- username match, nothing else about that profile. Safe to run more than once.

create or replace function public.lookup_email_by_username(p_username text)
returns text
language sql
security definer
set search_path = public
as $$
  select au.email
  from auth.users au
  join public.profiles p on p.id = au.id
  where p.username = p_username
  limit 1;
$$;

-- Must be callable while signed OUT (that's the whole point -- resolving the identifier is
-- step one of logging in), so anon gets this alongside authenticated.
grant execute on function public.lookup_email_by_username(text) to anon, authenticated;
