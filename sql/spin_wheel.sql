-- Spin-to-win prize wheel: one server-decided spin per account, reserved/released at
-- checkout using the exact same one-time-use pattern already established for the referral
-- signup discount (reserve_referee_discount / release_referee_discount in
-- referral_reviews_schema.sql) -- so it composes safely with everything else already in
-- checkout.js/webhook.js. Safe to run more than once.
--
-- NOTE: this file previously existed only as an untracked file in an unrelated worktree, never
-- committed to this branch or main -- the columns/functions below already exist live in
-- Supabase from that. This commit is just bringing the real source into version control,
-- alongside the prize-lineup change described next.
--
-- All six prizes are physical mystery gifts, rarity tiers (most common -> rarest):
--   Mystery Keychain        (32% -- most common)
--   Mystery Sticky Notes    (24%)
--   3x Mystery Cup-Wraps    (18%)
--   Mystery Custom Pen      (13% -- same underlying prize/mailing path as before, just a rarer
--                             tier and a "Mystery"-prefixed label now)
--   Mystery T-Shirt         (8%)
--   Mystery Pop-Socket      (5% -- rarest; same underlying prize/mailing path as before)
--
-- Percent-off prizes ('percent', pct 5/10/15) and the old 'mystery_gift' prize are DELIBERATELY
-- REMOVED from the odds below -- a %-off prize could never actually apply for the Gold/VIP
-- members most likely to win it, since it was competing against their own already-equal-or-
-- better standing discount for Stripe's one discount-per-session slot (5% spin vs. Gold's own
-- 5% standing = a redundant "win" that could never legally beat its own tie). Physical prizes
-- can't have that problem -- they never touch pricing or that discount slot at all.
--
-- IMPORTANT: 'percent' and 'mystery_gift' remain valid, fully-supported STORED values --
-- anyone who already spun and won one of those under the old odds keeps their legitimately-won
-- prize and it still redeems correctly (see api/checkout.js and index.html's SPIN_PRIZE_LABELS/
-- SPIN_PRIZE_DISPLAY, both of which keep those entries). Only NEW spins can no longer land on
-- them -- this file only changes what claim_spin_prize() can hand out going forward.

alter table public.profiles
  add column if not exists spin_claimed_at timestamptz,        -- set once, first spin only -- makes it one-per-account
  add column if not exists spin_prize_type text,                -- see the six current values above; 'percent' / 'mystery_gift' remain valid legacy stored values
  add column if not exists spin_prize_pct integer,               -- only ever meaningful for a legacy 'percent' prize; every current prize leaves this null
  add column if not exists spin_prize_used boolean not null default false;  -- one-time redemption at checkout

-- Rolls (and permanently records) the prize server-side, so it can't be influenced or replayed
-- from the browser -- the wheel animation on the frontend just visually lands on whatever this
-- returns, it never decides the outcome itself. Uses auth.uid() internally (never a client-
-- supplied id) so a caller can only ever spin for their own account, same reasoning as
-- has_purchased() elsewhere in this file set.
create or replace function public.claim_spin_prize()
returns table(already_spun boolean, prize_type text, prize_pct integer)
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_existing_claimed_at timestamptz;
  v_existing_type text;
  v_existing_pct integer;
  v_roll numeric;
  v_type text;
  v_pct integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select spin_claimed_at, spin_prize_type, spin_prize_pct
    into v_existing_claimed_at, v_existing_type, v_existing_pct
  from profiles where id = v_uid;

  if v_existing_claimed_at is not null then
    return query select true, v_existing_type, v_existing_pct;
    return;
  end if;

  v_roll := random();
  if v_roll < 0.32 then
    v_type := 'mystery_keychain'; v_pct := null;
  elsif v_roll < 0.56 then
    v_type := 'mystery_sticky_notes'; v_pct := null;
  elsif v_roll < 0.74 then
    v_type := 'mystery_cup_wraps'; v_pct := null;
  elsif v_roll < 0.87 then
    v_type := 'custom_pen'; v_pct := null;
  elsif v_roll < 0.95 then
    v_type := 'mystery_tshirt'; v_pct := null;
  else
    v_type := 'pop_socket'; v_pct := null;
  end if;

  update profiles set spin_claimed_at = now(), spin_prize_type = v_type, spin_prize_pct = v_pct where id = v_uid;
  return query select false, v_type, v_pct;
end;
$$;

grant execute on function public.claim_spin_prize() to authenticated;

-- Reserve/release pair, same shape as reserve_referee_discount/release_referee_discount --
-- called server-side (service role) from checkout.js/webhook.js, so these trust a passed-in
-- p_user_id (the caller is already-authenticated server code, not the browser directly).
-- Type-agnostic -- works identically for every prize type, past or present, since it only
-- ever flips spin_prize_used and never looks at what the prize actually is.
create or replace function public.reserve_spin_prize(p_user_id uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare applied boolean;
begin
  update profiles
  set spin_prize_used = true
  where id = p_user_id and spin_prize_type is not null and spin_prize_used = false
  returning true into applied;
  return coalesce(applied, false);
end;
$$;

create or replace function public.release_spin_prize(p_user_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update profiles set spin_prize_used = false where id = p_user_id;
end;
$$;
