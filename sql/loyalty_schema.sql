-- Loyalty program schema for the `profiles` table.
-- Safe to run more than once (everything is IF NOT EXISTS / CREATE OR REPLACE).
-- Run this in the Supabase SQL editor.

-- 1. Columns -----------------------------------------------------------

alter table public.profiles
  -- Legacy XP column -- no longer written to (tiers are now gated on total_spent/tier_spend
  -- directly, see lib/loyalty.js). Left in place rather than dropped since it's harmless and
  -- this migration's one-time grandfathering backfill (below) still needs to read it once.
  add column if not exists xp integer not null default 0,
  add column if not exists badges text[] not null default '{}',
  -- Lifetime spend, never reset. Drives badges (big_spender, etc.) and a lifetime leaderboard.
  add column if not exists total_spent numeric(10,2) not null default 0,
  -- Spend toward the CURRENT tier -- resets to 0 once a year on the user's own signup
  -- anniversary (see api/cron-tier-reset.js). This, not total_spent, is what tierForSpend
  -- in lib/loyalty.js is actually called with.
  add column if not exists tier_spend numeric(10,2) not null default 0,
  -- One-time migration safety net: the tier name a profile displayed under the OLD xp-based
  -- thresholds at the moment this migration ran (see the backfill at the bottom of this file).
  -- effectiveTierName() in lib/loyalty.js treats this as a FLOOR on top of the real
  -- tier_spend-derived tier, so nobody was visibly demoted by the XP->dollars switch itself.
  -- Cleared automatically by cron-tier-reset.js the next time that user's annual reset fires,
  -- so it's a one-cycle safety net, not a standing exemption.
  add column if not exists grandfathered_tier text,
  add column if not exists order_count integer not null default 0,
  add column if not exists birthday date,
  add column if not exists birthday_code text,
  add column if not exists birthday_code_expires timestamptz,
  add column if not exists birthday_code_year integer,
  -- VIP's $3.50-off-shipping perk, capped at 2 uses per calendar month (see use_vip_shipping_credit below)
  add column if not exists vip_credit_month text,
  add column if not exists vip_credit_uses_this_month integer not null default 0,
  -- Stock-alert preference (see handleStockAlertsToggle in index.html)
  add column if not exists stock_alerts_enabled boolean not null default false,
  add column if not exists stock_alert_method text not null default 'email',
  add column if not exists stock_alert_phone text;

-- 2. Atomic "record spend for a completed order" ----------------------------
-- Called once per Stripe checkout.session.completed event by webhook.js, guarded there by
-- a Redis one-time claim so a Stripe webhook retry can never double-call this. Increments
-- BOTH total_spent (lifetime) and tier_spend (resets annually) by the same raw order amount --
-- there's no separate points formula anymore, the dollars themselves are the tier metric.
-- The old version of this function returned a different column set (it had xp instead of
-- tier_spend/grandfathered_tier) -- Postgres won't let CREATE OR REPLACE change a function's
-- return type, so the old one has to be dropped by its old signature first. Safe to run more
-- than once: after the first run this DROP simply won't find a match and no-ops.
drop function if exists public.award_loyalty(uuid, integer, numeric, integer);
create or replace function public.award_loyalty(
  p_user_id uuid,
  p_spent_delta numeric,
  p_order_items integer
)
returns table (total_spent numeric, tier_spend numeric, order_count integer, grandfathered_tier text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update profiles
  set total_spent = profiles.total_spent + p_spent_delta,
      tier_spend  = profiles.tier_spend + p_spent_delta,
      order_count = profiles.order_count + 1
  where profiles.id = p_user_id
  returning profiles.total_spent, profiles.tier_spend, profiles.order_count, profiles.grandfathered_tier;
end;
$$;

-- 2b. Atomic "claw back spend for a refunded/canceled order" ----------------
-- Called by the charge.refunded handler in webhook.js (both full and partial refunds --
-- p_spend_delta is whatever dollar amount Stripe reports as refunded). Floors at 0 so a
-- refund can never push either total below zero. Deliberately does NOT touch order_count or
-- badges -- see the charge.refunded handler in webhook.js for why.
create or replace function public.reverse_loyalty_spend(
  p_user_id uuid,
  p_spend_delta numeric
)
returns table (total_spent numeric, tier_spend numeric)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update profiles
  set total_spent = greatest(profiles.total_spent - p_spend_delta, 0),
      tier_spend  = greatest(profiles.tier_spend - p_spend_delta, 0)
  where profiles.id = p_user_id
  returning profiles.total_spent, profiles.tier_spend;
end;
$$;

-- 3. Atomic, de-duplicated badge append ---------------------------------
create or replace function public.add_badges(
  p_user_id uuid,
  p_new_badges text[]
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  result text[];
begin
  update profiles
  set badges = (
    select array_agg(distinct b) from unnest(profiles.badges || p_new_badges) as b
  )
  where id = p_user_id
  returning badges into result;
  return result;
end;
$$;

-- 3b. Leaderboard read -------------------------------------------------------
-- Called by index.html's loadLeaderboard(). NOTE: this function previously existed only in
-- the live Supabase instance, not in source control -- adding it here now since it needs to
-- change anyway (ranks by lifetime total_spent instead of xp) and belongs in the migration.
-- Ranked by lifetime total_spent (never resets) rather than tier_spend (resets annually) so
-- the leaderboard reflects all-time standing, not just the current qualification period --
-- the tier shown per row is looked up client-side from tier_spend + grandfathered_tier via
-- effectiveTierName(), same as everywhere else on the page.
-- The pre-existing version of this function (never in source control -- see the note at the
-- top of this section) returned a different column set, so it has to be dropped by its old
-- signature first, same reasoning as award_loyalty above.
drop function if exists public.get_leaderboard(integer);
create or replace function public.get_leaderboard(p_limit integer default 10)
returns table (
  username text,
  avatar_url text,
  selected_badge text,
  total_spent numeric,
  tier_spend numeric,
  grandfathered_tier text
)
language sql
stable
security definer
set search_path = public
as $$
  select username, avatar_url, selected_badge, total_spent, tier_spend, grandfathered_tier
  from public.profiles
  order by total_spent desc
  limit p_limit;
$$;

-- 4. VIP monthly shipping credit ($3.50 off, capped at 2 uses/calendar month) -------------
-- Reserved optimistically in checkout.js when a VIP session is created (mirrors how stock
-- is reserved optimistically), then released back in webhook.js if that session expires
-- unpaid -- so an abandoned cart never permanently burns one of the two monthly uses.
create or replace function public.use_vip_shipping_credit(
  p_user_id uuid,
  p_year_month text  -- e.g. '2026-07', so usage naturally resets each new month
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  applied boolean;
begin
  update profiles
  set vip_credit_uses_this_month = case
        when vip_credit_month = p_year_month then vip_credit_uses_this_month + 1
        else 1
      end,
      vip_credit_month = p_year_month
  where id = p_user_id
    and (vip_credit_month is distinct from p_year_month or vip_credit_uses_this_month < 2)
  returning true into applied;

  return coalesce(applied, false);
end;
$$;

create or replace function public.release_vip_shipping_credit(
  p_user_id uuid,
  p_year_month text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only roll back if we're still in the same month it was reserved in -- if the month has
  -- already rolled over, that reset already effectively released it.
  update profiles
  set vip_credit_uses_this_month = greatest(vip_credit_uses_this_month - 1, 0)
  where id = p_user_id
    and vip_credit_month = p_year_month;
end;
$$;

-- 5. One-time grandfathering backfill --------------------------------------
-- Run once, at the moment the tier system switches from XP to real dollars spent. For every
-- profile that doesn't already have a floor, stamps in whatever tier their OLD xp value would
-- have earned them under the pre-migration thresholds (Silver @ 100, Gold @ 500, VIP @ 2000).
-- Anyone at the old free default (xp < 100, displayed as "Bronze") is skipped -- dropping from
-- the old free tier to the new free tier ("Crew Member") isn't a real demotion.
-- Safe to run more than once: only touches rows where grandfathered_tier is still null, so it
-- won't re-stamp anyone whose floor has already been cleared by their annual reset.
update public.profiles
set grandfathered_tier = case
  when xp >= 2000 then 'VIP'
  when xp >= 500  then 'Gold'
  when xp >= 100  then 'Silver'
  else null
end
where grandfathered_tier is null
  and xp >= 100;

-- 6. Row Level Security ---------------------------------------------------
-- These RPCs run as SECURITY DEFINER and are only ever called by webhook.js,
-- cron-birthday-coupons.js, and cron-tier-reset.js using the Supabase SERVICE ROLE key, which
-- bypasses RLS entirely -- so no new policies are required for them to work.
--
-- The browser writes directly to a few of the shopper's own fields (see index.html):
-- `birthday` (saveBirthday), and `stock_alerts_enabled` / `stock_alert_method` /
-- `stock_alert_phone` (handleStockAlertsToggle / handleStockAlertMethodChange). If profiles
-- doesn't already have a self-update policy, add one scoped to their own row:
--
-- create policy "Users can update their own profile"
--   on public.profiles for update
--   using (auth.uid() = id)
--   with check (auth.uid() = id);
--
-- That policy is row-level, not column-level -- it does not by itself stop a user from
-- crafting a raw REST call that also sets birthday_code/total_spent/tier_spend/badges/
-- vip_credit_* on their own row. Those columns are only ever meant to be written by the
-- webhook, checkout, and the two crons (all using the service role key, which bypasses RLS
-- regardless). If that matters for your threat model, lock the browser-writable path down to
-- just the allowed columns with a trigger like:
--
-- create or replace function public.protect_loyalty_columns()
-- returns trigger language plpgsql as $$
-- begin
--   if not (auth.role() = 'service_role') then
--     new.birthday_code := old.birthday_code;
--     new.birthday_code_expires := old.birthday_code_expires;
--     new.birthday_code_year := old.birthday_code_year;
--     new.xp := old.xp;
--     new.badges := old.badges;
--     new.total_spent := old.total_spent;
--     new.tier_spend := old.tier_spend;
--     new.grandfathered_tier := old.grandfathered_tier;
--     new.order_count := old.order_count;
--     new.vip_credit_month := old.vip_credit_month;
--     new.vip_credit_uses_this_month := old.vip_credit_uses_this_month;
--   end if;
--   return new;
-- end;
-- $$;
--
-- create trigger protect_loyalty_columns
--   before update on public.profiles
--   for each row execute function public.protect_loyalty_columns();
