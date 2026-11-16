-- yalla-sa module: operators as tenants, Supabase Auth users, memberships and RLS.
-- The old shared-password RPCs keep working (pinned to Derech Egged) until the switch is confirmed.

-- ---------- tenants ----------
create table public.operators (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  name text not null check (length(name) <= 120),
  operator_ref int,
  logo_url text check (logo_url is null or logo_url ~ '^(https://|data/|assets/)'),
  created_at timestamptz not null default now()
);
insert into public.operators (slug, name, operator_ref) values ('derech-egged', 'דרך אגד עוטף ירושלים', 135);

-- ---------- people ----------
create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  operator_id uuid not null references public.operators (id) on delete cascade,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  created_by uuid,
  primary key (user_id, operator_id)
);
create index memberships_operator_idx on public.memberships (operator_id);

-- ---------- helpers (not exposed through the API) ----------
create or replace function private.role_rank(r text) returns int
language sql immutable set search_path = '' as $$
  select case r when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 else 99 end $$;

create or replace function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins where user_id = (select auth.uid())) $$;

create or replace function private.has_role(op uuid, min_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_platform_admin() or exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid()) and m.operator_id = op
      and private.role_rank(m.role) >= private.role_rank(min_role)) $$;

-- any operator at all (for the shared road-distance cache)
create or replace function private.has_any_role(min_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_platform_admin() or exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid()) and private.role_rank(m.role) >= private.role_rank(min_role)) $$;

create or replace function private.legacy_op() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.operators where slug = 'derech-egged' $$;

create or replace function private.stamp() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;

revoke all on function private.role_rank(text), private.is_platform_admin(), private.has_role(uuid, text),
  private.has_any_role(text), private.legacy_op(), private.stamp() from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.role_rank(text), private.is_platform_admin(), private.has_role(uuid, text),
  private.has_any_role(text) to authenticated;
-- private tables are reached only through security-definer functions
revoke all on all tables in schema private from public, anon, authenticated;
alter table private.edit_secret enable row level security;
alter table private.failed_attempts enable row level security;
alter table private.data_key enable row level security;

do $$
declare t text; op uuid := (select id from public.operators where slug = 'derech-egged');
begin
  foreach t in array array['settings', 'reinforcement', 'overnight_override', 'auto_rein_status'] loop
    execute format('alter table public.%I add column operator_id uuid references public.operators (id) on delete cascade', t);
    execute format('update public.%I set operator_id = %L', t, op);
    execute format('alter table public.%I alter column operator_id set not null', t);
    execute format('alter table public.%I add column updated_by uuid', t);
    execute format('create trigger stamp before insert or update on public.%I for each row execute function private.stamp()', t);
  end loop;
end $$;

alter table public.settings drop constraint settings_pkey, add primary key (operator_id, key),
  add constraint settings_key_check check (key in ('depots', 'fuel_stations', 'driver_change_points', 'defaults', 'vehicles')),
  add constraint settings_size_check check (octet_length(value::text) <= 500000);
alter table public.reinforcement drop constraint reinforcement_pkey, add primary key (operator_id, day, veh, start_min),
  add constraint reinforcement_check check (line is not null and rein_km is not null and length(veh) <= 40
    and start_min between -1440 and 4320 and length(line) <= 20 and coalesce(length(route_frm), 0) <= 200
    and coalesce(length(route_to), 0) <= 200 and coalesce(length(note), 0) <= 300);
alter table public.overnight_override drop constraint overnight_override_pkey, add primary key (operator_id, day, veh),
  add constraint overnight_override_input_check check (length(veh) <= 40 and coalesce(length(note), 0) <= 500);
alter table public.auto_rein_status drop constraint auto_rein_status_pkey, add primary key (operator_id, day, veh, start_min),
  add constraint auto_rein_status_input_check check (length(veh) <= 40 and start_min between -1440 and 4320);
alter table public.road_cache add constraint road_cache_range_check check (
  a_lat between 29 and 34 and b_lat between 29 and 34 and a_lon between 34 and 36.5 and b_lon between 34 and 36.5
  and km between 0 and 1000 and min between 0 and 1500);

-- per-operator data key (AES-256, decrypts data/<slug>/day_*.js)
alter table private.data_key add column operator_id uuid references public.operators (id) on delete cascade;
update private.data_key set operator_id = private.legacy_op();
alter table private.data_key drop constraint data_key_pkey, drop constraint data_key_id_check, drop column id,
  alter column operator_id set not null, add primary key (operator_id);

-- ---------- RLS ----------
alter table public.operators enable row level security;
alter table public.platform_admins enable row level security;
alter table public.memberships enable row level security;

create policy operators_read on public.operators for select to authenticated using (private.has_role(id, 'viewer'));
create policy operators_admin on public.operators for update to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy platform_admins_self on public.platform_admins for select to authenticated using (user_id = (select auth.uid()));
create policy memberships_read on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or private.has_role(operator_id, 'admin'));
-- memberships are written only by the manage_users Edge Function (service role)

do $$
declare t text;
begin
  foreach t in array array['settings', 'reinforcement', 'overnight_override', 'auto_rein_status'] loop
    execute format('create policy %I on public.%I for select to authenticated using (private.has_role(operator_id, ''viewer''))', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (private.has_role(operator_id, ''editor''))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.has_role(operator_id, ''editor'')) with check (private.has_role(operator_id, ''editor''))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (private.has_role(operator_id, ''editor''))', t || '_delete', t);
  end loop;
end $$;
create policy road_cache_read on public.road_cache for select to authenticated using (private.has_any_role('viewer'));
create policy road_cache_insert on public.road_cache for insert to authenticated with check (private.has_any_role('editor'));
create policy road_cache_update on public.road_cache for update to authenticated
  using (private.has_any_role('editor')) with check (private.has_any_role('editor'));

-- grants: nothing for anon; row access for authenticated is decided by the policies above
revoke all on public.operators, public.platform_admins, public.memberships, public.settings, public.reinforcement,
  public.overnight_override, public.auto_rein_status, public.road_cache from anon, authenticated;
grant select on public.operators, public.platform_admins, public.memberships to authenticated;
grant update (logo_url, name) on public.operators to authenticated;
grant select, insert, update, delete on public.settings, public.reinforcement, public.overnight_override,
  public.auto_rein_status to authenticated;
grant select, insert, update on public.road_cache to authenticated;

-- data key for members only
create or replace function public.get_operator_key(p_operator uuid) returns text
language sql stable security definer set search_path = '' as $$
  select k.key_b64 from private.data_key k where k.operator_id = p_operator and private.has_role(p_operator, 'viewer') $$;
revoke all on function public.get_operator_key(uuid) from public, anon;
grant execute on function public.get_operator_key(uuid) to authenticated;

-- ---------- sign-up only for invited addresses ----------
create table private.signup_allow (
  email text primary key,
  created_at timestamptz not null default now()
);
alter table private.signup_allow enable row level security;
revoke all on private.signup_allow from public, anon, authenticated;

create or replace function private.block_public_signup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.signup_allow where created_at < now() - interval '30 days';
  if exists (select 1 from private.signup_allow where email = lower(new.email)) then
    delete from private.signup_allow where email = lower(new.email);
    return new;
  end if;
  raise exception 'signup_disabled';
end $$;
revoke all on function private.block_public_signup() from public, anon, authenticated;
create trigger block_public_signup before insert on auth.users for each row execute function private.block_public_signup();

-- called by the manage_users Edge Function (service role) right before it creates an invited user
create or replace function public.allow_signup(p_email text) returns void
language sql security definer set search_path = '' as $$
  insert into private.signup_allow (email) values (lower(trim(p_email))) on conflict (email) do update set created_at = now() $$;
revoke all on function public.allow_signup(text) from public, anon, authenticated;
grant execute on function public.allow_signup(text) to service_role;

-- ---------- legacy shared-password RPCs, pinned to Derech Egged (removed after the switch) ----------
create or replace function public.get_data_key(p_password text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not private.verify(p_password) then return null; end if;
  return (select key_b64 from private.data_key where operator_id = private.legacy_op());
end $$;

create or replace function public.get_settings(p_password text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.verify(p_password) then return null; end if;
  return coalesce((select jsonb_object_agg(key, value) from public.settings where operator_id = private.legacy_op()), '{}'::jsonb);
end $$;

create or replace function public.save_setting(p_password text, p_key text, p_value jsonb) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not private.verify(p_password) then return 'wrong_password'; end if;
  if p_key not in ('depots','fuel_stations','driver_change_points','defaults','vehicles') then return 'bad_key'; end if;
  if octet_length(p_value::text) > 500000 then return 'too_large'; end if;
  insert into public.settings (operator_id, key, value) values (private.legacy_op(), p_key, p_value)
  on conflict (operator_id, key) do update set value = excluded.value;
  return 'ok';
end $$;

create or replace function public.get_reinforcement(p_password text, p_day date) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.verify(p_password) then return null; end if;
  return coalesce((select jsonb_agg(to_jsonb(r) - 'updated_at' - 'updated_by' - 'operator_id') from public.reinforcement r
                   where r.day = p_day and r.operator_id = private.legacy_op()), '[]'::jsonb);
end $$;

create or replace function public.set_reinforcement(p_password text, p_day date, p_veh text, p_start_min integer, p_km numeric, p_on boolean,
  p_line text default null, p_route_frm text default null, p_route_to text default null, p_rein_km numeric default null,
  p_before_km numeric default null, p_after_km numeric default null, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not private.verify(p_password) then return 'wrong_password'; end if;
  if p_on then
    if p_line is null or p_rein_km is null then return 'missing_line'; end if;
    insert into public.reinforcement (operator_id, day, veh, start_min, km, line, route_frm, route_to, rein_km, before_km, after_km, note)
    values (private.legacy_op(), p_day, p_veh, p_start_min, p_km, left(p_line,20), left(p_route_frm,200), left(p_route_to,200), p_rein_km, p_before_km, p_after_km, left(p_note,300))
    on conflict (operator_id, day, veh, start_min) do update set km=excluded.km, line=excluded.line, route_frm=excluded.route_frm, route_to=excluded.route_to,
      rein_km=excluded.rein_km, before_km=excluded.before_km, after_km=excluded.after_km, note=excluded.note;
  else
    delete from public.reinforcement where operator_id = private.legacy_op() and day = p_day and veh = p_veh and start_min = p_start_min;
  end if;
  return 'ok';
end $$;

create or replace function public.get_overnight(p_password text, p_day date) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.verify(p_password) then return null; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('veh', veh, 'mode', mode, 'note', note))
                   from public.overnight_override where day = p_day and operator_id = private.legacy_op()), '[]'::jsonb);
end $$;

create or replace function public.set_overnight(p_password text, p_day date, p_veh text, p_mode text, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not private.verify(p_password) then return 'wrong_password'; end if;
  if p_veh is null or length(p_veh) > 40 or (p_note is not null and length(p_note) > 500) then return 'bad_input'; end if;
  if p_mode = 'stay' then
    delete from public.overnight_override where operator_id = private.legacy_op() and day = p_day and veh = p_veh;
  elsif p_mode in ('depot','rein') then
    insert into public.overnight_override (operator_id, day, veh, mode, note) values (private.legacy_op(), p_day, p_veh, p_mode, p_note)
    on conflict (operator_id, day, veh) do update set mode = excluded.mode, note = excluded.note;
  else return 'bad_input'; end if;
  return 'ok';
end $$;

create or replace function public.get_auto_rein(p_password text, p_day date) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.verify(p_password) then return null; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('veh', veh, 'start_min', start_min, 'status', status))
                   from public.auto_rein_status where day = p_day and operator_id = private.legacy_op()), '[]'::jsonb);
end $$;

create or replace function public.set_auto_rein(p_password text, p_day date, p_veh text, p_start_min integer, p_status text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not private.verify(p_password) then return 'wrong_password'; end if;
  if p_veh is null or length(p_veh) > 40 or p_start_min is null or p_start_min not between -1440 and 4320 then return 'bad_input'; end if;
  if p_status = 'auto' then
    delete from public.auto_rein_status where operator_id = private.legacy_op() and day = p_day and veh = p_veh and start_min = p_start_min;
  elsif p_status in ('confirmed','rejected') then
    insert into public.auto_rein_status (operator_id, day, veh, start_min, status) values (private.legacy_op(), p_day, p_veh, p_start_min, p_status)
    on conflict (operator_id, day, veh, start_min) do update set status = excluded.status;
  else return 'bad_input'; end if;
  return 'ok';
end $$;
