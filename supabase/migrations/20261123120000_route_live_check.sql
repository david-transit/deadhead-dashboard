-- R51 live check (David, 23.11.2026): a route warning marked "לבדיקה ידנית" has a "בדיקה עכשיו" button in the route
-- warnings list. The click goes to the Edge Function route_check (Google Routes, key on the server, quota through
-- google_take / google_usage) and Google's km is shown beside ours, in memory only. NOTHING FROM GOOGLE IS STORED:
-- no table here has a column for it, and the function keeps no log, cache or row of it (Maps ToS 3.2.3, Service Terms
-- 19.2-19.3; docs/reports/google-maps-terms-2026-11-22.md in transit-platform).
-- After the check the user decides:
--   "אישור מסלול"     -> a route_ok row (existing table: the pair, OUR km, who, when). The warning stays hidden on that
--                       pair until our km changes (rokChanged in assets/app.js).
--   "עדכון ק״מ ידני"   -> a route_km_manual row (this migration): the km the user typed (never pre-filled with, or
--                       suggested from, Google's km), OUR km at that time, who, when. The dashboard uses the typed km for
--                       the leg while our km stays the same; when our km changes the warning comes back.
-- Permission: the portal capability "בדיקה ואישור מסלול" = the deadhead role editor or admin at the operator (managed in
-- the portal's control room), or platform admin: private.can_verify_route(). RLS uses it; the Edge Function asks
-- public.can_verify_route() with the caller's own token before it spends quota.

create or replace function private.can_verify_route(op uuid) returns boolean
  language sql stable security definer set search_path = '' as $$ select private.has_role(op, 'editor') $$;
revoke all on function private.can_verify_route(uuid) from public, anon;
grant execute on function private.can_verify_route(uuid) to authenticated;

-- for the Edge Function (called with the user's token, so auth.uid() is the caller)
create or replace function public.can_verify_route(p_operator uuid) returns boolean
  language sql stable security definer set search_path = '' as $$ select private.can_verify_route(p_operator) $$;
revoke all on function public.can_verify_route(uuid) from public, anon;
grant execute on function public.can_verify_route(uuid) to authenticated;

-- "מסלול תקין" / "אישור מסלול": insert and delete now follow the capability (same people as before: editor+)
drop policy if exists route_ok_insert on public.route_ok;
drop policy if exists route_ok_delete on public.route_ok;
create policy route_ok_insert on public.route_ok for insert to authenticated with check (private.can_verify_route(operator_id));
create policy route_ok_delete on public.route_ok for delete to authenticated using (private.can_verify_route(operator_id));

create table if not exists public.route_km_manual (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id) on delete cascade,
  a_lat numeric(8,5) not null check (a_lat between 29 and 34), a_lon numeric(8,5) not null check (a_lon between 34 and 36.5),
  b_lat numeric(8,5) not null check (b_lat between 29 and 34), b_lon numeric(8,5) not null check (b_lon between 34 and 36.5),
  km numeric(7,2) not null check (km > 0 and km <= 500),          -- typed by the user ("הוזן ידנית")
  our_km numeric(7,2) not null check (our_km >= 0 and our_km <= 500), -- our computed km when it was typed
  origin text check (char_length(origin) <= 200),
  destination text check (char_length(destination) <= 200),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (operator_id, a_lat, a_lon, b_lat, b_lon)
);
alter table public.route_km_manual enable row level security;

-- who and when are set by the DB, not the browser
create or replace function private.guard_route_km_manual() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.created_by := auth.uid(); new.created_at := now();
  return new;
end $$;
revoke all on function private.guard_route_km_manual() from public, anon, authenticated;
drop trigger if exists guard_route_km_manual on public.route_km_manual;
create trigger guard_route_km_manual before insert on public.route_km_manual for each row execute function private.guard_route_km_manual();

drop policy if exists route_km_manual_read on public.route_km_manual;
drop policy if exists route_km_manual_insert on public.route_km_manual;
drop policy if exists route_km_manual_delete on public.route_km_manual;
create policy route_km_manual_read on public.route_km_manual for select to authenticated using (private.has_role(operator_id, 'viewer'));
create policy route_km_manual_insert on public.route_km_manual for insert to authenticated with check (private.can_verify_route(operator_id));
create policy route_km_manual_delete on public.route_km_manual for delete to authenticated using (private.can_verify_route(operator_id));
revoke all on public.route_km_manual from anon, authenticated;
grant select, insert, delete on public.route_km_manual to authenticated;  -- no update: change = delete + insert

-- "מי" next to a typed km / an approval: the names of the people who wrote block edits, a typed km or a route approval
create or replace function public.edit_authors(p_operator uuid) returns table (user_id uuid, name text)
language sql stable security definer set search_path = '' as $$
  select p.user_id, coalesce(nullif(p.display_name, ''), p.username) from public.profiles p
  where private.has_role(p_operator, 'viewer')
    and (p.user_id in (select e.created_by from public.block_edits e where e.operator_id = p_operator)
      or p.user_id in (select m.created_by from public.route_km_manual m where m.operator_id = p_operator)
      or p.user_id in (select o.created_by from public.route_ok o where o.operator_id = p_operator)) $$;
revoke all on function public.edit_authors(uuid) from public, anon;
grant execute on function public.edit_authors(uuid) to authenticated;
