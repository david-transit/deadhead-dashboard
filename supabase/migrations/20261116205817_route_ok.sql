-- route_ok ("מסלול תקין"): an origin -> destination pair an editor marked as a correct route, for all days. The pair is
-- the routed pair after the stop anchor (same coordinates as the road_cache key, 5 decimals). It hides only the
-- "עיקוף גדול" / "מסלול חשוד" warnings of that pair while the computed km stays within 0.3 km and 10% of km (the km at
-- marking time); "לא נכנס בזמן" is never hidden. Per operator: viewer+ reads, editor+ inserts / deletes (through the
-- drafts and "שמירה"); no updates (cancel = delete, mark again = insert). No existing row is changed.
create table if not exists public.route_ok (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id) on delete cascade,
  a_lat numeric(8,5) not null check (a_lat between 29 and 34), a_lon numeric(8,5) not null check (a_lon between 34 and 36.5),
  b_lat numeric(8,5) not null check (b_lat between 29 and 34), b_lon numeric(8,5) not null check (b_lon between 34 and 36.5),
  km numeric(7,2) not null check (km >= 0 and km <= 500),
  origin text check (char_length(origin) <= 200),
  destination text check (char_length(destination) <= 200),
  note text check (char_length(note) <= 300),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (operator_id, a_lat, a_lon, b_lat, b_lon)
);
alter table public.route_ok enable row level security;

create or replace function private.guard_route_ok() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.created_by := auth.uid(); new.created_at := now();
  return new;
end $$;
revoke all on function private.guard_route_ok() from public, anon, authenticated;
drop trigger if exists guard_route_ok on public.route_ok;
create trigger guard_route_ok before insert on public.route_ok for each row execute function private.guard_route_ok();

drop policy if exists route_ok_read on public.route_ok;
drop policy if exists route_ok_insert on public.route_ok;
drop policy if exists route_ok_delete on public.route_ok;
create policy route_ok_read on public.route_ok for select to authenticated using (private.has_role(operator_id, 'viewer'));
create policy route_ok_insert on public.route_ok for insert to authenticated with check (private.has_role(operator_id, 'editor'));
create policy route_ok_delete on public.route_ok for delete to authenticated using (private.has_role(operator_id, 'editor'));
revoke all on public.route_ok from anon, authenticated;
grant select, insert, delete on public.route_ok to authenticated;

-- Seed (run separately as SQL, 2026-11-16, session_replication_role=replica to keep created_by = the reporter): Derech
-- Egged 'ירושלים, כניסה ראשית/הדסה עין כרם' 31.76635,35.14881 -> 'מבשרת ציון, הראל/יסמין' 31.79996,35.14805, 10 km,
-- from David's route report of 15.11 ("מסלול תקין, זאת הדרך האפשרית"); that report was set to resolved.
