-- TikTok Live status: a single public flag, toggled from admin.html, read live by every
-- storefront visitor via Supabase Realtime. Deliberately NOT a serverless function -- this
-- project is already at Vercel Hobby's 12-function cap (see the comment in api/products.js) --
-- writes go straight from admin.html to this table under RLS, same pattern already used by the
-- "Admins can upload/update/delete product images" storage policies in
-- sql/product_catalog_schema.sql. Safe to run more than once.
--
-- Singleton row (id is always 'main') -- there's only ever one "are we live right now" state.

create table if not exists public.site_status (
  id text primary key default 'main',
  is_live boolean not null default false,
  live_note text,                -- optional, e.g. "Sale tier open now!" shown in the banner
  live_url text,                 -- optional deep link straight to the TikTok stream itself
  default_tier text,             -- optional TIKTOK_TIERS key ('destash'/'sale'/'new'), pre-selects that tier when the Live Claims modal opens while live
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.site_status (id, is_live) values ('main', false)
on conflict (id) do nothing;

alter table public.site_status enable row level security;

drop policy if exists "Anyone can read site status" on public.site_status;
create policy "Anyone can read site status"
  on public.site_status for select
  using (true);

drop policy if exists "Admins can update site status" on public.site_status;
create policy "Admins can update site status"
  on public.site_status for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- Deliberately no insert/delete policy -- the single 'main' row is seeded once above and only
-- ever updated after that, never re-created or removed.

grant select on public.site_status to anon, authenticated;
grant update on public.site_status to authenticated; -- RLS above still restricts this to admins only
grant all on public.site_status to service_role;

-- Realtime only streams postgres_changes for tables explicitly added to this publication --
-- guarded (rather than a bare ALTER PUBLICATION) since re-adding an already-added table errors.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'site_status'
  ) then
    alter publication supabase_realtime add table public.site_status;
  end if;
end $$;
