-- Referral system + verified-purchase reviews.
-- Safe to run more than once (IF NOT EXISTS / CREATE OR REPLACE throughout).
-- Run this in the Supabase SQL editor, alongside loyalty_schema.sql.

-- ============================================================================
-- 1. Referral columns on profiles
-- ============================================================================
alter table public.profiles
  add column if not exists referral_code text unique,
  -- SET NULL, never CASCADE -- see account_deletion_cascade.sql for why.
  add column if not exists referred_by uuid references auth.users(id) on delete set null,
  -- The referee's ONE-TIME 15% off their first order.
  add column if not exists referral_signup_discount_used boolean not null default false,
  -- The referrer's queue of earned "15% off your next order" rewards -- a count, not a
  -- boolean, because a referrer can refer multiple friends before using any of them up.
  add column if not exists referral_reward_pending integer not null default 0,
  -- Lifetime successful-referral count, purely for display + the 'referral' badge.
  add column if not exists referral_count integer not null default 0;

-- referral_code is generated client-side at login (deterministic from the user's own id --
-- see index.html) and self-heals into existing rows the first time they log in after this
-- migration runs. No backfill needed here.

-- ============================================================================
-- 2. Referral RPCs
-- ============================================================================
-- Referrer redeeming one of their earned 15%-off-next-order rewards. Reserved optimistically
-- at checkout (same pattern as VIP shipping credit / stock), released back if that session
-- expires unpaid.
create or replace function public.reserve_referral_reward(p_user_id uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare applied boolean;
begin
  update profiles
  set referral_reward_pending = referral_reward_pending - 1
  where id = p_user_id and referral_reward_pending > 0
  returning true into applied;
  return coalesce(applied, false);
end;
$$;

create or replace function public.release_referral_reward(p_user_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update profiles set referral_reward_pending = referral_reward_pending + 1 where id = p_user_id;
end;
$$;

-- Referee's one-time 15% off their first order. Same reserve/release pattern.
create or replace function public.reserve_referee_discount(p_user_id uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare applied boolean;
begin
  update profiles
  set referral_signup_discount_used = true
  where id = p_user_id and referred_by is not null and referral_signup_discount_used = false
  returning true into applied;
  return coalesce(applied, false);
end;
$$;

create or replace function public.release_referee_discount(p_user_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update profiles set referral_signup_discount_used = false where id = p_user_id;
end;
$$;

-- Called from webhook.js when a referee's order_count reaches 1 (their real first order) --
-- grants the REFERRER one reward and bumps their lifetime referral_count. Returns the new
-- count so the caller knows whether this was the referrer's first-ever successful referral
-- (for the 'referral' badge).
create or replace function public.grant_referral_reward(p_referrer_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare new_count integer;
begin
  update profiles
  set referral_reward_pending = referral_reward_pending + 1,
      referral_count = referral_count + 1
  where id = p_referrer_id
  returning referral_count into new_count;
  return new_count;
end;
$$;

-- Looking up a referrer by their code needs to read a DIFFERENT user's row -- profiles' RLS
-- only allows reading your own row (auth.uid() = id), so a direct client-side select silently
-- returns nothing rather than erroring. This narrow SECURITY DEFINER function is the fix: it
-- runs with elevated privilege but returns ONLY the matching id, nothing else about that
-- profile, so it can't be used to read anyone's other data.
create or replace function public.lookup_referrer_id(p_code text)
returns uuid
language sql security definer set search_path = public
as $$
  select id from profiles where referral_code = p_code limit 1;
$$;

-- purchases has zero RLS policies on purpose (nobody's browser should read anyone's purchase
-- history directly). But the "can I review this" check in index.html needs SOME way to ask
-- "did I buy this" without that broad access. This is the safe narrow answer: it uses
-- auth.uid() internally (the CALLER's own id from their session, not a value the client can
-- pass in and spoof), so it can only ever check your own purchases, never anyone else's.
create or replace function public.has_purchased(p_product_id text)
returns boolean
language sql security definer set search_path = public
as $$
  select exists (
    select 1 from purchases where user_id = auth.uid() and product_id = p_product_id
  );
$$;

-- ============================================================================
-- 3. Purchases ledger -- powers the verified-purchase gate on reviews
-- ============================================================================
-- Populated by webhook.js on checkout.session.completed, for every line item (not just
-- stock-tracked ones -- unlike the stock-sync loop, reviews need ALL purchases recorded).
-- Not exposed to the browser at all: no RLS policies below means default-deny for
-- anon/authenticated, only the service role (webhook.js, submit-review.js) can touch it.
create table if not exists public.purchases (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  session_id text not null,
  purchased_at timestamptz not null default now(),
  unique (user_id, product_id, session_id)
);
alter table public.purchases enable row level security;

-- KNOWN LIMITATION: only logged-in checkouts get recorded here (same as loyalty spend -- guest
-- checkouts have no supabase_user_id to attach to). A guest who buys something and later
-- creates an account won't be able to review that product, even with the same email.

-- ============================================================================
-- 4. Reviews
-- ============================================================================
create table if not exists public.reviews (
  id bigserial primary key,
  product_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  username text,
  rating integer not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  unique (product_id, user_id) -- one review per person per product
);
alter table public.reviews enable row level security;

-- Reviews are public to read (star ratings + comments show on the storefront for everyone,
-- logged in or not). Dropped-then-recreated rather than a bare CREATE POLICY, since Postgres
-- has no "CREATE POLICY IF NOT EXISTS" -- without this guard, re-running this whole file a
-- second time would error here (and, if Supabase's SQL editor sends the paste as one atomic
-- multi-statement transaction, that error could roll back everything else in the same run,
-- including anything earlier in the file that hadn't been run yet).
drop policy if exists "Anyone can read reviews" on public.reviews;
create policy "Anyone can read reviews"
  on public.reviews for select
  using (true);

-- Deliberately NO insert policy for anon/authenticated -- all writes go through
-- /api/submit-review.js using the service role, because the verified-purchase check has to
-- happen server-side (a client-only RLS check can't verify what's in the purchases table
-- against Stripe-confirmed orders in a way a browser can't spoof).

-- ============================================================================
-- 5. Wishlists -- lightweight backend mirror, powers targeted (not blanket) restock alerts
-- ============================================================================
-- The wishlist itself still lives in the browser's localStorage as the source of truth for
-- the shopping experience (variants, attached DTFs, prices, etc. -- see index.html). This
-- table only mirrors the product ids, and only for logged-in shoppers, just so the backend
-- has SOME way to know who wants what -- previously it had none at all, which is why restock
-- alerts used to go out to every subscriber for every restock regardless of relevance.
--
-- Unlike purchases/reviews, a wishlist is just a personal preference with nothing to verify,
-- so direct self-service RLS (rather than a routed-through-a-server-endpoint pattern) is fine.
create table if not exists public.wishlists (
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  added_at timestamptz not null default now(),
  primary key (user_id, product_id)
);
alter table public.wishlists enable row level security;

drop policy if exists "Users can view their own wishlist" on public.wishlists;
create policy "Users can view their own wishlist"
  on public.wishlists for select
  using (auth.uid() = user_id);

drop policy if exists "Users can add to their own wishlist" on public.wishlists;
create policy "Users can add to their own wishlist"
  on public.wishlists for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can remove from their own wishlist" on public.wishlists;
create policy "Users can remove from their own wishlist"
  on public.wishlists for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- 6. Admin flag -- powers the manual restock tool (Admin Tools panel in Settings)
-- ============================================================================
-- Unlike total_spent/tier_spend/badges/birthday_code (whose protection is left as an OPTIONAL commented-out
-- trigger in loyalty_schema.sql), is_admin gets a real, applied trigger -- it grants genuine
-- backend power (editing any product's inventory), not just cosmetic loyalty stats, so
-- leaving it merely RLS-row-protected (same as everything else on profiles) isn't enough.
alter table public.profiles add column if not exists is_admin boolean not null default false;

create or replace function public.protect_is_admin_column()
returns trigger language plpgsql as $$
begin
  -- auth.role() reads 'anon'/'authenticated'/'service_role' from the request's JWT when this
  -- update comes in through PostgREST (i.e. from the browser) -- so this blocks anyone editing
  -- their own is_admin via the app's normal update path. It returns NULL when there's no JWT
  -- context at all, which is exactly what running SQL directly in the Supabase SQL editor
  -- looks like -- so YOUR direct SQL updates to grant/revoke admin still work fine.
  if not (auth.role() = 'service_role') and new.is_admin is distinct from old.is_admin then
    new.is_admin := old.is_admin;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_is_admin on public.profiles;
create trigger protect_is_admin
  before update on public.profiles
  for each row execute function public.protect_is_admin_column();

-- Grant yourself and your mom admin access (run once, with your real user ids):
-- update profiles set is_admin = true where id in ('<your id>', '<mom''s id>');