-- Local product catalog: categories / products / product_variants.
-- Replaces Stripe Products/Prices as the source of truth for the storefront -- Stripe becomes
-- invisible payment plumbing only (a minimal synced Product+Price per catalog product, see
-- lib/stripe-sync.js). Safe to run more than once (IF NOT EXISTS / DROP+CREATE POLICY throughout).
-- Run this in the Supabase SQL editor, then run scripts/migrate-catalog.js once to populate it
-- from the live Stripe catalog + the hardcoded config that used to live in index.html.

-- ============================================================================
-- 1. Categories -- drives both the shop filter bar and the admin "add product" form.
-- ============================================================================
create table if not exists public.categories (
  id text primary key,                     -- slug, e.g. 'thread-tshirt', 'dtf-pocket', 'loaded-binders'
  label text not null,                     -- display name, e.g. "T-Shirts"
  parent_id text references public.categories(id) on delete set null,  -- e.g. dtf-pocket/dtf-kids under dtf
  filter_group text,                        -- which top-level filter button this rolls into ('dtf','thread','loaded-binders','corporate')
  card_layout_type text not null check (card_layout_type in ('variant-apparel','gallery','design-attach','simple')),
  sort_order integer not null default 99,
  size_chart_image_url text,                -- per-category size chart, replaces the old single global SizeChart.jpg
  config jsonb not null default '{}'::jsonb,  -- layout-specific fields: sizes[], dtf_default_placement, dtf_center_chest,
                                               -- dtf_pocket_matrix, max_thumbnails -- see admin.html for the editor
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.categories enable row level security;

drop policy if exists "Anyone can read active categories" on public.categories;
create policy "Anyone can read active categories"
  on public.categories for select
  using (true);

-- Deliberately no insert/update/delete policy for anon/authenticated -- all writes go through
-- api/admin-categories.js using the service role, same pattern as restock_log.

-- ============================================================================
-- 2. Products -- our own catalog, Stripe ids are sync plumbing, not the source of truth.
-- ============================================================================
create table if not exists public.products (
  id text primary key default gen_random_uuid()::text,
  category_id text not null references public.categories(id) on delete restrict,
  name text not null,
  description text,
  images text[] not null default '{}',      -- ordered Supabase Storage (or legacy static) URLs, images[0] = main photo
  price_cents integer not null,
  sort_order integer not null default 99,
  published boolean not null default true,
  dtf_placement jsonb,                       -- {top,left,width,height} override of the category default
  sub_category_id text references public.categories(id) on delete set null,  -- e.g. dtf items filed under dtf-pocket/dtf-kids
  stock integer,                             -- cold-storage mirror for non-variant categories; null = untracked/unlimited
  -- Free-form escape hatch for DTF *design* products specifically: per-garment placement
  -- fine-tuning (scale_tshirt, nudge_x_hoodie, visual_scale, design_type, etc.) used by
  -- openDtfSelector()/applyDtfToTarget() in index.html. These don't fit a fixed column because
  -- the key set is open-ended (one per garment shortname) -- kept exactly as free-form
  -- key/value pairs the way Stripe metadata already was, edited via admin.html's "Advanced
  -- metadata" field.
  extra_metadata jsonb not null default '{}'::jsonb,
  -- Stripe sync plumbing, written only by lib/stripe-sync.js:
  stripe_product_id text,
  stripe_price_id text,
  stripe_sync_status text,                   -- 'ok' | 'error'
  stripe_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists products_category_idx on public.products(category_id);
create index if not exists products_sub_category_idx on public.products(sub_category_id);
alter table public.products enable row level security;

drop policy if exists "Anyone can read published products" on public.products;
create policy "Anyone can read published products"
  on public.products for select
  using (published = true);

-- Deliberately no insert/update/delete policy for anon/authenticated -- all writes go through
-- api/admin-products.js using the service role.

-- ============================================================================
-- 3. Product variants -- one row per size/color combo, for variant-apparel/design-attach categories.
-- ============================================================================
create table if not exists public.product_variants (
  id bigserial primary key,
  product_id text not null references public.products(id) on delete cascade,
  size text not null,
  color text not null,
  color_image_url text,                      -- per-product-per-color photo (generalizes the old shared category color map)
  stock integer not null default 0,          -- cold-storage mirror; Redis stock_<productId>_<key> remains the live source
  unique (product_id, size, color)
);
create index if not exists product_variants_product_idx on public.product_variants(product_id);
alter table public.product_variants enable row level security;

drop policy if exists "Anyone can read variants of published products" on public.product_variants;
create policy "Anyone can read variants of published products"
  on public.product_variants for select
  using (exists (select 1 from public.products p where p.id = product_id and p.published = true));

-- ============================================================================
-- 4. Grants -- same defensive pattern as grants.sql (table-level grants are evaluated before
--    RLS even runs, so a missing one here means "permission denied" regardless of policy).
-- ============================================================================
grant select on public.categories, public.products, public.product_variants to anon, authenticated;
grant all on public.categories, public.products, public.product_variants to service_role;
grant usage, select on public.product_variants_id_seq to service_role;

-- ============================================================================
-- 5. Storage bucket for admin-uploaded product/category images.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

drop policy if exists "Public read of product images" on storage.objects;
create policy "Public read of product images"
  on storage.objects for select
  using (bucket_id = 'product-images');

drop policy if exists "Admins can upload product images" on storage.objects;
create policy "Admins can upload product images"
  on storage.objects for insert
  with check (
    bucket_id = 'product-images'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

drop policy if exists "Admins can update product images" on storage.objects;
create policy "Admins can update product images"
  on storage.objects for update
  using (
    bucket_id = 'product-images'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

drop policy if exists "Admins can delete product images" on storage.objects;
create policy "Admins can delete product images"
  on storage.objects for delete
  using (
    bucket_id = 'product-images'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );
