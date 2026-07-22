-- DTF Graveyard & Resurrection: when a DTF product (category 'dtf'/'dtf-pocket'/'dtf-kids')
-- sells out, it moves to a 'graveyard' category (created through admin.html's Categories tab,
-- not here -- same as every other category row) instead of just sitting there "OUT OF STOCK".
-- Shoppers can pre-order it back with a "Resurrect" purchase; the move only actually happens
-- once that payment succeeds (see api/webhook.js), not on click.
--
-- Reserve/finalize shape mirrors reserve_spin_prize/release_spin_prize in spin_wheel.sql: server
-- code (service role, via api/checkout.js and api/webhook.js) calls these with an explicit
-- p_product_id, trusting the caller since it's never exposed directly to the browser. Safe to
-- run more than once.

alter table public.products
  add column if not exists pre_graveyard_category_id text references public.categories(id) on delete set null,
  add column if not exists pre_graveyard_sub_category_id text references public.categories(id) on delete set null,
  add column if not exists resurrection_restock_qty integer;  -- admin-set per product; null falls back to a default in code/RPC

-- Moves a sold-out DTF product into the Graveyard, remembering its real category so it can be
-- restored later. No-op (returns false) if the product isn't a DTF category, still has stock, or
-- is already in the Graveyard -- so it's safe to call unconditionally any time stock might have
-- hit zero, from both api/webhook.js (checkout path) and api/admin-restock.js (manual path).
create or replace function public.move_product_to_graveyard(p_product_id text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_category_id text;
  v_sub_category_id text;
  v_stock integer;
  applied boolean;
begin
  select category_id, sub_category_id, stock
    into v_category_id, v_sub_category_id, v_stock
  from products where id = p_product_id
  for update;

  if v_category_id is null then
    return false; -- product not found
  end if;

  if v_category_id not in ('dtf', 'dtf-pocket', 'dtf-kids') then
    return false; -- not a DTF product (also covers "already in graveyard" -- 'graveyard' isn't in this list)
  end if;

  if coalesce(v_stock, 0) > 0 then
    return false; -- still in stock, nothing to do
  end if;

  update products
  set pre_graveyard_category_id = v_category_id,
      pre_graveyard_sub_category_id = v_sub_category_id,
      category_id = 'graveyard',
      sub_category_id = null
  where id = p_product_id
  returning true into applied;

  return coalesce(applied, false);
end;
$$;

-- Restores a Graveyard product to its original category and gives it fresh stock, but only the
-- FIRST call to actually find it still in the Graveyard wins -- the row lock from "for update"
-- serializes concurrent resurrection payments for the same product, so if two people pay around
-- the same moment, the second call simply finds category_id already restored and returns an
-- empty result set (both orders still get fulfilled normally; only one triggers the
-- email/animation in webhook.js).
create or replace function public.resurrect_product(p_product_id text, p_default_restock_qty integer default 3)
returns table(id text, name text, images text[], restored_category_id text, restored_category_label text, restock_qty integer)
language plpgsql security definer set search_path = public
as $$
declare
  v_category_id text;
  v_pre_category text;
  v_pre_sub_category text;
  v_qty integer;
begin
  select p.category_id, p.pre_graveyard_category_id, p.pre_graveyard_sub_category_id,
         coalesce(p.resurrection_restock_qty, p_default_restock_qty)
    into v_category_id, v_pre_category, v_pre_sub_category, v_qty
  from products p where p.id = p_product_id
  for update;

  if v_category_id is distinct from 'graveyard' or v_pre_category is null then
    return; -- already resurrected (lost the race) or was never in the graveyard -- empty result set
  end if;

  update products
  set category_id = v_pre_category,
      sub_category_id = v_pre_sub_category,
      stock = v_qty,
      pre_graveyard_category_id = null,
      pre_graveyard_sub_category_id = null
  where products.id = p_product_id;

  return query
    select p.id, p.name, p.images, v_pre_category, c.label, v_qty
    from products p
    left join categories c on c.id = v_pre_category
    where p.id = p_product_id;
end;
$$;

-- Deliberately no grant to anon/authenticated -- both functions are called server-side only
-- (service role, from api/checkout.js and api/webhook.js), same as reserve_spin_prize/
-- release_spin_prize in spin_wheel.sql.
