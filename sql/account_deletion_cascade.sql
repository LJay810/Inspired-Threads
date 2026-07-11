-- Makes account deletion actually work as a single action: delete the user from Supabase's
-- Authentication panel, and everything downstream cleans up automatically.
--
-- CASCADE on purchases/reviews/wishlists/profiles.id -- these rows are meaningless without
-- that specific account, so they're deleted along with it.
--
-- SET NULL (never CASCADE) on profiles.referred_by -- if the person who referred someone gets
-- deleted, the person THEY referred must NOT also get deleted. That would mean removing one
-- account could silently cascade into deleting other, unrelated customers. This just forgets
-- who referred them; their own account and history stay intact.
--
-- Purely a behavior change for FUTURE deletions -- does not touch, move, or delete any
-- existing data. Safe to run any time, safe to re-run.

do $$
declare
  con_name text;
begin
  -- purchases.user_id -> CASCADE
  select tc.constraint_name into con_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
  where tc.table_schema = 'public' and tc.table_name = 'purchases'
    and kcu.column_name = 'user_id' and tc.constraint_type = 'FOREIGN KEY';
  if con_name is not null then
    execute format('alter table public.purchases drop constraint %I', con_name);
  end if;
  alter table public.purchases
    add constraint purchases_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;

  -- reviews.user_id -> CASCADE
  select tc.constraint_name into con_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
  where tc.table_schema = 'public' and tc.table_name = 'reviews'
    and kcu.column_name = 'user_id' and tc.constraint_type = 'FOREIGN KEY';
  if con_name is not null then
    execute format('alter table public.reviews drop constraint %I', con_name);
  end if;
  alter table public.reviews
    add constraint reviews_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;

  -- wishlists.user_id -> CASCADE
  select tc.constraint_name into con_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
  where tc.table_schema = 'public' and tc.table_name = 'wishlists'
    and kcu.column_name = 'user_id' and tc.constraint_type = 'FOREIGN KEY';
  if con_name is not null then
    execute format('alter table public.wishlists drop constraint %I', con_name);
  end if;
  alter table public.wishlists
    add constraint wishlists_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;

  -- profiles.referred_by -> SET NULL (see the big warning at the top of this file)
  select tc.constraint_name into con_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
  where tc.table_schema = 'public' and tc.table_name = 'profiles'
    and kcu.column_name = 'referred_by' and tc.constraint_type = 'FOREIGN KEY';
  if con_name is not null then
    execute format('alter table public.profiles drop constraint %I', con_name);
  end if;
  alter table public.profiles
    add constraint profiles_referred_by_fkey foreign key (referred_by) references auth.users(id) on delete set null;

  -- profiles.id -> CASCADE -- this is the one that actually makes "delete from the Auth panel
  -- alone" work: without it, deleting the auth user would leave an orphaned profiles row behind
  -- (or just fail outright), same underlying issue as the other three above.
  select tc.constraint_name into con_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
  where tc.table_schema = 'public' and tc.table_name = 'profiles'
    and kcu.column_name = 'id' and tc.constraint_type = 'FOREIGN KEY';
  if con_name is not null then
    execute format('alter table public.profiles drop constraint %I', con_name);
  end if;
  alter table public.profiles
    add constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade;
end $$;
