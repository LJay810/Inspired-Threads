-- Admin panel QOL upgrades: restock activity log.
-- Safe to run more than once (IF NOT EXISTS / CREATE OR REPLACE throughout).

create table if not exists public.restock_log (
  id bigserial primary key,
  admin_user_id uuid references auth.users(id) on delete set null, -- SET NULL: losing who did it shouldn't delete the history of what happened
  admin_label text,        -- snapshot of the admin's username/email at the time, survives even if that account is later deleted
  product_id text not null,
  product_name text,
  stripe_meta_key text not null,
  previous_qty integer not null,
  new_qty integer not null,
  notified boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.restock_log enable row level security;

-- Only admins can read this -- checked via a subquery against the CALLER's own profiles row,
-- which their own existing "view own profile" policy already permits them to read, so this
-- works without needing any new grant on profiles itself.
drop policy if exists "Admins can view restock log" on public.restock_log;
create policy "Admins can view restock log"
  on public.restock_log for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- Deliberately no insert policy for anon/authenticated -- only admin-restock.js writes here,
-- using the service role, which bypasses RLS regardless.

-- Explicit grants, defensive: grants.sql's default-privileges statements SHOULD already cover
-- a table created this recently, but given tonight's repeated pattern of new tables silently
-- missing a grant, this makes it certain rather than assumed.
grant select on public.restock_log to authenticated;
grant all on public.restock_log to service_role;
grant usage, select on public.restock_log_id_seq to service_role;
