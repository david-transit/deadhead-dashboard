-- Route problems sent for review ("שלח לבדיקה" / "הצע נקודת מעבר" / "הערה" in the route-warnings list) and the road
-- geometry of cached routes (shown on the map dialogs). No existing row is changed.
-- road_cache.geom: JSON {"p":[encoded polyline, ...]} (OSRM polyline precision 5), filled on demand when a map is opened.
alter table public.road_cache add column if not exists geom text;
alter table public.road_cache drop constraint if exists road_cache_geom_size;
alter table public.road_cache add constraint road_cache_geom_size check (geom is null or octet_length(geom) <= 40000);

-- route_reports: an editor (or above) of the operator inserts (through the drafts and "שמירה"); only a platform admin
-- reads and updates them (the architect reviews them with David).
create table if not exists public.route_reports (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id) on delete cascade,
  day date not null,
  origin text not null check (char_length(origin) <= 200),
  destination text not null check (char_length(destination) <= 200),
  legs jsonb not null default '[]'::jsonb check (octet_length(legs::text) <= 20000),
  text text check (char_length(text) <= 2000),
  proposed_via jsonb check (proposed_via is null or octet_length(proposed_via::text) <= 2000),
  status text not null default 'new' check (status in ('new', 'checking', 'resolved', 'rejected')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  resolved_note text check (char_length(resolved_note) <= 2000)
);
create index if not exists route_reports_operator_day on public.route_reports (operator_id, day);
alter table public.route_reports enable row level security;
create or replace function private.guard_route_report() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_at := now();
    if not private.is_platform_admin() then new.status := 'new'; new.resolved_note := null; end if;
  else
    new.created_by := old.created_by; new.created_at := old.created_at; new.operator_id := old.operator_id;
  end if;
  return new;
end $$;
revoke all on function private.guard_route_report() from public, anon, authenticated;
drop trigger if exists guard_route_report on public.route_reports;
create trigger guard_route_report before insert or update on public.route_reports for each row execute function private.guard_route_report();
drop policy if exists route_reports_insert on public.route_reports;
drop policy if exists route_reports_read on public.route_reports;
drop policy if exists route_reports_update on public.route_reports;
create policy route_reports_insert on public.route_reports for insert to authenticated with check (private.has_role(operator_id, 'editor'));
create policy route_reports_read on public.route_reports for select to authenticated using (private.is_platform_admin());
create policy route_reports_update on public.route_reports for update to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());
revoke all on public.route_reports from anon, authenticated;
grant insert, select, update on public.route_reports to authenticated;
