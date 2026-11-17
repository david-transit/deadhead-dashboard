-- Personal devices ("זכור את המכשיר") with remote disconnect (David, 2026-11-18; prerequisite for extending to 30 days).
-- A device = one Supabase Auth session (auth.sessions; the JWT carries its id in the session_id claim).
-- * public.trusted_devices: which sessions the user marked as personal, until when. No RLS policies: only manage_users
--   (service role) reads and writes it, through the functions below.
-- * Disconnect = delete the auth.sessions row: its refresh tokens go with it (the device can never refresh), GoTrue
--   refuses its access token (/user -> manage_users answers not_signed_in), and the DB refuses it too:
--   private.session_alive() is part of private.is_active() (every role check and data RPC) and a RESTRICTIVE policy on
--   every public table, so the very next request of a disconnected device gets nothing, even before its JWT expires.

create table if not exists public.trusted_devices (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  marked_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.trusted_devices enable row level security;
revoke all on public.trusted_devices from anon, authenticated;
create index if not exists trusted_devices_user on public.trusted_devices(user_id);

-- the session of the calling JWT still exists (not signed out / disconnected)
create or replace function private.session_alive() returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.sessions s where s.id = nullif((select auth.jwt() ->> 'session_id'), '')::uuid) $$;
revoke all on function private.session_alive() from public, anon;
grant execute on function private.session_alive() to authenticated;

create or replace function private.is_active() returns boolean
  language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null
     and exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and not p.must_change_password and not p.disabled)
     and private.mfa_ok()
     and private.session_alive() $$;

-- every public table: a disconnected session sees and writes nothing (also the self-read policies that skip is_active)
do $$
declare t text;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and c.relname <> 'trusted_devices'
  loop
    execute format('drop policy if exists session_alive on public.%I', t);
    execute format('create policy session_alive on public.%I as restrictive for all to authenticated using (private.session_alive()) with check (private.session_alive())', t);
  end loop;
end $$;

-- ---------- service-role functions (manage_users) ----------
create or replace function public.device_trust(p_user uuid, p_session uuid, p_hours int) returns timestamptz
  language plpgsql security definer set search_path = '' as $$
declare e timestamptz := now() + make_interval(hours => greatest(1, least(coalesce(p_hours, 12), 720)));
begin
  if not exists (select 1 from auth.sessions s where s.id = p_session and s.user_id = p_user) then
    raise exception 'session_not_found';
  end if;
  insert into public.trusted_devices (session_id, user_id, marked_at, expires_at) values (p_session, p_user, now(), e)
    on conflict (session_id) do update set marked_at = now(), expires_at = excluded.expires_at;
  return e;
end $$;

create or replace function public.device_untrust(p_user uuid, p_session uuid) returns void
  language sql security definer set search_path = '' as $$
  delete from public.trusted_devices where session_id = p_session and user_id = p_user $$;

-- p_user null = every user (platform admin view); expired marks are removed first
create or replace function public.device_list(p_user uuid default null)
  returns table (session_id uuid, user_id uuid, username text, display_name text, marked_at timestamptz,
                 expires_at timestamptz, user_agent text, last_used timestamptz)
  language plpgsql security definer set search_path = '' as $$
begin
  delete from public.trusted_devices d where d.expires_at < now();
  return query
    select d.session_id, d.user_id, p.username, p.display_name, d.marked_at, d.expires_at, s.user_agent,
           coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at)
    from public.trusted_devices d
    join auth.sessions s on s.id = d.session_id
    left join public.profiles p on p.user_id = d.user_id
    where p_user is null or d.user_id = p_user
    order by d.marked_at desc;
end $$;

-- disconnect: the session is deleted (refresh tokens and the trusted mark go with it); returns its owner
create or replace function public.device_revoke(p_session uuid) returns uuid
  language plpgsql security definer set search_path = '' as $$
declare u uuid;
begin
  delete from auth.sessions where id = p_session returning user_id into u;
  return u;
end $$;

-- the owner of a session (for the permission check before a disconnect)
create or replace function public.session_owner(p_session uuid) returns uuid
  language sql stable security definer set search_path = '' as $$
  select user_id from auth.sessions where id = p_session $$;

revoke all on function public.device_trust(uuid, uuid, int), public.device_untrust(uuid, uuid), public.device_list(uuid),
  public.device_revoke(uuid), public.session_owner(uuid) from public, anon, authenticated;
grant execute on function public.device_trust(uuid, uuid, int), public.device_untrust(uuid, uuid), public.device_list(uuid),
  public.device_revoke(uuid), public.session_owner(uuid) to service_role;
