-- Crew Cash: a per-shopper spendable balance ("credit_balance" on profiles -- this column
-- already exists live in Supabase, same situation as username/avatar_url/selected_badge, which
-- were also bootstrapped directly in the dashboard and never captured in tracked SQL until now).
-- Funded manually only for now (an admin adjusts it via the existing Customer Lookup tool, same
-- place total_spent/tier_spend/badges already get edited) -- no automatic funding source yet.
--
-- Spent at checkout like a gift-card balance: reserved optimistically when a Checkout Session is
-- created (mirrors use_vip_shipping_credit's exact shape in loyalty_schema.sql), released back in
-- webhook.js if that session expires unpaid or session creation fails outright. Safe to run more
-- than once.

alter table public.profiles
  add column if not exists credit_balance numeric(10,2) not null default 0;

create or replace function public.use_crew_cash(p_user_id uuid, p_amount numeric)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  applied boolean;
begin
  update profiles
  set credit_balance = credit_balance - p_amount
  where id = p_user_id and credit_balance >= p_amount
  returning true into applied;

  return coalesce(applied, false);
end;
$$;

create or replace function public.release_crew_cash(p_user_id uuid, p_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update profiles set credit_balance = credit_balance + p_amount where id = p_user_id;
end;
$$;
