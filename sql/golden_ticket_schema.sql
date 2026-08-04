-- Golden Ticket: an admin picks one product to secretly go free for whoever buys it first.
-- The flag itself is the only new state needed here -- "has this already been claimed" lives in
-- Redis (see api/checkout.js), same reserve/release idiom already used for referral rewards,
-- spin prizes, and VIP shipping credits elsewhere in this codebase. Safe to run more than once.

alter table public.products
  add column if not exists is_golden_ticket boolean not null default false;

-- Partial index -- this is only ever queried as "which product (if any) is currently golden,"
-- a rare/small result set, so indexing just the true rows keeps it tiny regardless of catalog size.
create index if not exists products_golden_ticket_idx on public.products (is_golden_ticket) where is_golden_ticket;

-- No RLS/grant changes needed: products already has public SELECT for published rows (see
-- product_catalog_schema.sql) which covers this new column for free, and all WRITES already go
-- through api/admin-products.js using the service role, same as every other product field.
