-- Username + password accounts (no email): Supabase Auth with an internal address <username>@users.yalla-sa.app
-- (never shown, never mailed). Profiles hold the username, display name and account state.
-- New or reset accounts must change their password before they get any data.

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9._-]{3,32}$'),
  display_name text not null default '' check (length(display_name) <= 80),
  must_change_password boolean not null default true,
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid
);

-- signed-in, enabled, password already changed
create or replace function private.is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and not exists (
    select 1 from public.profiles p where p.user_id = (select auth.uid()) and (p.must_change_password or p.disabled)) $$;

create or replace function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_active() and exists (select 1 from public.platform_admins where user_id = (select auth.uid())) $$;

create or replace function private.has_role(op uuid, min_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_active() and (private.is_platform_admin() or exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid()) and m.operator_id = op
      and private.role_rank(m.role) >= private.role_rank(min_role))) $$;

create or replace function private.has_any_role(min_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_active() and (private.is_platform_admin() or exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid()) and private.role_rank(m.role) >= private.role_rank(min_role))) $$;

revoke all on function private.is_active() from public, anon, authenticated;
grant execute on function private.is_active() to authenticated;

alter table public.profiles enable row level security;
create policy profiles_read on public.profiles for select to authenticated using (
  user_id = (select auth.uid()) or private.is_platform_admin()
  or exists (select 1 from public.memberships m where m.user_id = profiles.user_id and private.has_role(m.operator_id, 'admin')));
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
-- profiles are written only by the manage_users Edge Function (service role)

-- the first platform admin can be created once, from the login screen (server-enforced)
create table private.bootstrap (
  id int primary key default 1 check (id = 1),
  at timestamptz not null default now()
);
alter table private.bootstrap enable row level security;
revoke all on private.bootstrap from public, anon, authenticated;

create or replace function public.bootstrap_needed() returns boolean
language sql stable security definer set search_path = '' as $$ select not exists (select 1 from private.bootstrap) $$;
create or replace function public.claim_bootstrap() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.bootstrap (id) values (1) on conflict do nothing;
  return found;
end $$;
create or replace function public.release_bootstrap() returns void
language sql security definer set search_path = '' as $$
  delete from private.bootstrap where not exists (select 1 from public.platform_admins) $$;
revoke all on function public.bootstrap_needed(), public.claim_bootstrap(), public.release_bootstrap() from public, anon, authenticated;
grant execute on function public.bootstrap_needed(), public.claim_bootstrap(), public.release_bootstrap() to service_role;
