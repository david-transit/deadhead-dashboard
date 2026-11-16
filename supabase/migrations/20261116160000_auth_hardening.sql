-- Security review 2026-11-16: M2, M3 (MFA in the DB), M4, M6, L1, L3, L4, L5, L10.

-- ---------- L3 + M3: fail-closed roles; "active" needs a profile and, once a user has a verified MFA factor, an aal2 session
create or replace function private.role_rank(r text) returns int language sql immutable set search_path = '' as $$
  select case r when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 else 0 end $$;

-- enrolment first, enforcement follows by itself: a user with a verified TOTP factor gets no data / key / admin rights
-- from a password-only (aal1) session
create or replace function private.mfa_ok() returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified') $$;
revoke all on function private.mfa_ok() from public, anon;
grant execute on function private.mfa_ok() to authenticated;

create or replace function private.is_active() returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null
     and exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and not p.must_change_password and not p.disabled)
     and private.mfa_ok() $$;

-- ---------- M4 (a)+(b): passwords change only through manage_users; no mail is ever triggered for an internal address
create table if not exists private.pw_change_allow (user_id uuid primary key, at timestamptz not null default now());
create or replace function public.allow_pw_change(p_user uuid) returns void language sql security definer set search_path = '' as $$
  insert into private.pw_change_allow (user_id) values (p_user) on conflict (user_id) do update set at = now() $$;
revoke all on function public.allow_pw_change(uuid) from public, anon, authenticated;
grant execute on function public.allow_pw_change(uuid) to service_role;

create or replace function private.guard_auth_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- a new password needs a one-shot permit from manage_users (change_password / reset / recovery), so a stolen access
  -- token cannot set a password through PUT /auth/v1/user
  if new.encrypted_password is distinct from old.encrypted_password and coalesce(old.encrypted_password, '') <> '' then
    delete from private.pw_change_allow where user_id = new.id and at > now() - interval '2 minutes';
    if not found then raise exception 'password_change_not_allowed'; end if;
  end if;
  -- users never change their own address (admin updates set email directly, not email_change)
  if coalesce(new.email_change, '') <> '' and new.email_change is distinct from old.email_change then
    raise exception 'email_change_not_allowed';
  end if;
  -- the internal domain users.yalla-sa.app is not ours to receive mail: refuse every token that GoTrue would mail there
  if lower(new.email) like '%@users.yalla-sa.app' and (
       (coalesce(new.recovery_token, '') <> '' and new.recovery_token is distinct from old.recovery_token)
    or (coalesce(new.confirmation_token, '') <> '' and new.confirmation_token is distinct from old.confirmation_token)
    or (coalesce(new.reauthentication_token, '') <> '' and new.reauthentication_token is distinct from old.reauthentication_token)
    or (coalesce(new.email_change_token_current, '') <> '' and new.email_change_token_current is distinct from old.email_change_token_current)) then
    raise exception 'no_mail_to_internal_address';
  end if;
  return new;
end $$;
drop trigger if exists guard_auth_user on auth.users;
create trigger guard_auth_user before update on auth.users for each row execute function private.guard_auth_user();

-- M4 (c): a sign-up permit lives 10 minutes (was 30 days) and manage_users withdraws it when createUser fails
create or replace function private.block_public_signup() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from private.signup_allow where created_at < now() - interval '10 minutes';
  if exists (select 1 from private.signup_allow where email = lower(new.email)) then
    delete from private.signup_allow where email = lower(new.email);
    return new;
  end if;
  raise exception 'signup_disabled';
end $$;
create or replace function public.disallow_signup(p_email text) returns void language sql security definer set search_path = '' as $$
  delete from private.signup_allow where email = lower(trim(p_email)) $$;
revoke all on function public.disallow_signup(text) from public, anon, authenticated;
grant execute on function public.disallow_signup(text) to service_role;

-- ---------- M6: rate limit per username + IP, per username (all IPs) and per IP (all usernames); no full-day lock-out
alter table private.auth_attempts add column if not exists ip text;
create index if not exists auth_attempts_user on private.auth_attempts (username, kind, at);
create index if not exists auth_attempts_ip on private.auth_attempts (ip, at);
drop function if exists public.auth_attempt(text, text);
create or replace function public.auth_attempt(p_username text, p_kind text, p_ip text default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_user text := lower(p_username); v_ip text := left(coalesce(p_ip, ''), 64); n_ip15 int; n_ip24 int; n_user int; n_addr int;
begin
  delete from private.auth_attempts where at < now() - interval '2 days';
  select count(*) filter (where a.at > now() - interval '15 minutes'), count(*) into n_ip15, n_ip24
    from private.auth_attempts a where a.username = v_user and a.kind = p_kind and coalesce(a.ip, '') = v_ip and a.at > now() - interval '1 day';
  select count(*) into n_user from private.auth_attempts a where a.username = v_user and a.kind = p_kind and a.at > now() - interval '15 minutes';
  select count(*) into n_addr from private.auth_attempts a where v_ip <> '' and a.ip = v_ip and a.at > now() - interval '15 minutes';
  if n_ip15 >= 5 or n_ip24 >= 20 or n_user >= 100 or n_addr >= 60 then return false; end if;
  insert into private.auth_attempts (username, kind, ip) values (v_user, p_kind, nullif(v_ip, ''));
  return true;
end $$;
revoke all on function public.auth_attempt(text, text, text) from public, anon, authenticated;
grant execute on function public.auth_attempt(text, text, text) to service_role;

-- ---------- L4: never zero active platform admins, even with two concurrent removals (checked at commit, serialised)
create or replace function private.keep_platform_admin() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('yalla-sa:platform_admins'));
  if exists (select 1 from public.platform_admins) and not exists (
       select 1 from public.platform_admins a join public.profiles p on p.user_id = a.user_id where not p.disabled) then
    raise exception 'last_platform_admin';
  end if;
  return null;
end $$;
drop trigger if exists keep_platform_admin on public.platform_admins;
create constraint trigger keep_platform_admin after delete on public.platform_admins deferrable initially deferred
  for each row execute function private.keep_platform_admin();
drop trigger if exists keep_platform_admin on public.profiles;
create constraint trigger keep_platform_admin after update of disabled or delete on public.profiles deferrable initially deferred
  for each row execute function private.keep_platform_admin();

-- ---------- L1: the author of a block edit is the signed-in user, set by the DB and never changed afterwards
create or replace function private.edit_author() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then new.created_by := coalesce(auth.uid(), new.created_by); new.created_at := now();
  else new.created_by := old.created_by; new.created_at := old.created_at; end if;
  return new;
end $$;
drop trigger if exists block_edits_author on public.block_edits;
create trigger block_edits_author before insert or update on public.block_edits for each row execute function private.edit_author();

-- display names of the authors of an operator's block edits (members of that operator only)
create or replace function public.edit_authors(p_operator uuid) returns table (user_id uuid, name text)
language sql stable security definer set search_path = '' as $$
  select p.user_id, coalesce(nullif(p.display_name, ''), p.username) from public.profiles p
  where private.has_role(p_operator, 'viewer')
    and p.user_id in (select e.created_by from public.block_edits e where e.operator_id = p_operator) $$;
revoke all on function public.edit_authors(uuid) from public, anon;
grant execute on function public.edit_authors(uuid) to authenticated;

-- ---------- M2: road distances cached per operator (one operator's editor can no longer change another's km)
alter table public.road_cache add column if not exists operator_id uuid references public.operators (id) on delete cascade;
update public.road_cache set operator_id = (select id from public.operators where slug = 'derech-egged') where operator_id is null;
alter table public.road_cache alter column operator_id set not null;
alter table public.road_cache drop constraint if exists road_cache_pkey;
alter table public.road_cache add primary key (operator_id, a_lat, a_lon, b_lat, b_lon);
alter table public.road_cache add constraint road_cache_sane check (km >= 0 and km <= 1000 and min >= 0 and min <= 1440);
drop policy if exists road_cache_read on public.road_cache;
drop policy if exists road_cache_insert on public.road_cache;
drop policy if exists road_cache_update on public.road_cache;
create policy road_cache_read on public.road_cache for select to authenticated using (private.has_role(operator_id, 'viewer'));
create policy road_cache_insert on public.road_cache for insert to authenticated with check (private.has_role(operator_id, 'editor'));
create policy road_cache_update on public.road_cache for update to authenticated
  using (private.has_role(operator_id, 'editor')) with check (private.has_role(operator_id, 'editor'));

-- ---------- L10: a line key can never be a JavaScript prototype name
alter table public.rule_sets add constraint rule_sets_line_key_safe
  check (line_key is null or line_key !~ '^(__proto__|constructor|prototype)$');

-- ---------- L5: leftovers of the shared-password era
drop table if exists private.edit_secret;
drop table if exists private.failed_attempts;
