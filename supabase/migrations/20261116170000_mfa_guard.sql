-- M3 follow-up (found in live testing 2026-11-16): GoTrue lets a password-only (aal1) session add a second TOTP factor
-- (and verify it -> aal2) or delete a verified one. So once a user has a verified factor, adding or removing factors
-- needs a one-shot permit that only manage_users gives, and manage_users itself demands an aal2 session.
-- Unverified (unfinished) factors stay free to add/remove while no verified factor exists.
create table if not exists private.mfa_change_allow (user_id uuid primary key, at timestamptz not null default now());
create or replace function public.allow_mfa_change(p_user uuid) returns void language sql security definer set search_path = '' as $$
  insert into private.mfa_change_allow (user_id) values (p_user) on conflict (user_id) do update set at = now() $$;
revoke all on function public.allow_mfa_change(uuid) from public, anon, authenticated;
grant execute on function public.allow_mfa_change(uuid) to service_role;

create or replace function private.guard_mfa_factor() returns trigger language plpgsql security definer set search_path = '' as $$
declare u uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from auth.mfa_factors f where f.user_id = u and f.status = 'verified')
       and not exists (select 1 from private.mfa_change_allow a where a.user_id = u and a.at > now() - interval '2 minutes') then
      raise exception 'mfa_change_not_allowed';
    end if;
    return new;
  end if;
  -- DELETE of a verified factor (not when the whole user is being deleted: the cascade runs after the user row is gone)
  if old.status = 'verified' and exists (select 1 from auth.users where id = u)
     and not exists (select 1 from private.mfa_change_allow a where a.user_id = u and a.at > now() - interval '2 minutes') then
    raise exception 'mfa_change_not_allowed';
  end if;
  return old;
end $$;
drop trigger if exists guard_mfa_factor on auth.mfa_factors;
create trigger guard_mfa_factor before insert or delete on auth.mfa_factors for each row execute function private.guard_mfa_factor();

-- users that have a verified factor (control room list)
create or replace function public.mfa_users() returns setof uuid language sql stable security definer set search_path = '' as $$
  select distinct user_id from auth.mfa_factors where status = 'verified' $$;
revoke all on function public.mfa_users() from public, anon, authenticated;
grant execute on function public.mfa_users() to service_role;
