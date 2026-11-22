-- R51 (David 22.11.2026), NOT APPLIED until David decides (OP-DATA-10 / legal check): a route warning with no GPS passage,
-- checked against Google Routes: only yes / no and the date are kept, with OUR km (a changed leg is asked again). No km,
-- time, route or geometry from Google. Written by tools/google_yesno.py (service role); read by the operator's users.
create table public.route_gcheck (
  operator_id uuid not null references public.operators(id) on delete cascade,
  a_lat numeric not null, a_lon numeric not null, b_lat numeric not null, b_lon numeric not null,
  our_km numeric not null, ok boolean not null, checked_at timestamptz not null default now(),
  primary key (operator_id, a_lat, a_lon, b_lat, b_lon)
);
alter table public.route_gcheck enable row level security;
revoke all on public.route_gcheck from anon, authenticated;
grant select on public.route_gcheck to authenticated;
create policy route_gcheck_read on public.route_gcheck for select to authenticated using (private.has_role(operator_id, 'viewer'::text));
create policy session_alive on public.route_gcheck as restrictive for all to authenticated using (private.session_alive()) with check (private.session_alive());
