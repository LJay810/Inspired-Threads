-- Persists a logged-in shopper's cart to Supabase, not just localStorage. Before this, the cart
-- lived ONLY in the browser's localStorage -- meaning it was tied to one specific browser/app
-- context, not the account. A customer who added 60+ items on the installed PWA lost every one
-- of them the moment they had to switch to the regular mobile website (a completely separate
-- localStorage bucket on iOS, see the PWA/mobile-web storage-isolation notes elsewhere in this
-- project) and had to re-add everything by hand. This table is what index.html's saveCart() /
-- loadAndMergeCartFromSupabase() sync against so the SAME cart follows a logged-in account
-- across any browser/device/context, with localStorage remaining the fast, always-available
-- fallback for guests (no user_id to key by) and for instant first paint before the network
-- round-trip resolves.
--
-- Single JSONB blob per user (not a row-per-line-item table): the cart's actual item shape is
-- already a fairly rich, variable ad-hoc JS object (variant size/color, attached-DTF sub-items,
-- resurrection flag, TikTok-claim items, etc. -- see the several `cart.push({...})` call sites
-- in index.html) that was never designed against a fixed relational schema. Mirroring it as-is
-- (literally the same JSON already written to localStorage) avoids having to invent and maintain
-- a parallel relational shape for something that is, unlike orders/purchases, not a financial or
-- audit record -- just the shopper's own in-progress selection.

create table if not exists public.carts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  items jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.carts enable row level security;

drop policy if exists "Users can view their own cart" on public.carts;
create policy "Users can view their own cart"
  on public.carts for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own cart" on public.carts;
create policy "Users can insert their own cart"
  on public.carts for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own cart" on public.carts;
create policy "Users can update their own cart"
  on public.carts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own cart" on public.carts;
create policy "Users can delete their own cart"
  on public.carts for delete
  using (auth.uid() = user_id);

-- No policy grants anon anything -- guests never had a Supabase-backed cart to begin with, and
-- shouldn't gain one; localStorage remains their only cart storage, same as before this table
-- existed.

grant select, insert, update, delete on public.carts to authenticated;
grant all on public.carts to service_role;
-- No separate sequence grant needed (primary key is the user's own uuid, not a bigserial).
