-- Loyalty program schema for the `profiles` table.
-- Safe to run more than once (everything is IF NOT EXISTS / CREATE OR REPLACE).
-- Run this in the Supabase SQL editor.

-- 1. Columns -----------------------------------------------------------

alter table public.profiles
  add column if not exists xp integer not null default 0,
  add column if not exists badges text[] not null default '{}',
  add column if not exists total_spent numeric(10,2) not null default 0,
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

-- 2. Atomic "award XP for a completed order" ----------------------------
-- Called once per Stripe checkout.session.completed event by webhook.js, guarded there by
-- a Redis one-time claim so a Stripe webhook retry can never double-call this.
create or replace function public.award_loyalty(
  p_user_id uuid,
  p_xp_delta integer,
  p_spent_delta numeric,
  p_order_items integer
)
returns table (xp integer, total_spent numeric, order_count integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update profiles
  set xp          = profiles.xp + p_xp_delta,
      total_spent = profiles.total_spent + p_spent_delta,
      order_count = profiles.order_count + 1
  where profiles.id = p_user_id
  returning profiles.xp, profiles.total_spent, profiles.order_count;
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

-- 5. Row Level Security ---------------------------------------------------
-- These RPCs run as SECURITY DEFINER and are only ever called by webhook.js and
-- cron-birthday-coupons.js using the Supabase SERVICE ROLE key, which bypasses RLS
-- entirely -- so no new policies are required for them to work.
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
-- crafting a raw REST call that also sets birthday_code/xp/badges/vip_credit_* on their own
-- row. Those columns are only ever meant to be written by the webhook, checkout, and birthday
-- cron (all using the service role key, which bypasses RLS regardless). If that matters for
-- your threat model, lock the browser-writable path down to just the allowed columns with a
-- trigger like:
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
