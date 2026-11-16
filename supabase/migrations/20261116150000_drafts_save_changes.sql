-- Draft + save: the dashboard keeps every edit as a local draft and writes them all at once with save_changes
-- (one transaction; security invoker, so the table RLS = editor role applies to every row). No row is changed here.

-- overnight choice details (overnight reinforcement: line, direction, time, depot wait; depots fixed at choice time)
alter table public.overnight_override add column if not exists detail jsonb;
alter table public.overnight_override add constraint overnight_override_detail_size
  check (detail is null or octet_length(detail::text) <= 20000);
comment on column public.overnight_override.day is
  'Night before service day "day" (between the last day the vehicle ran and "day"); read by both days.';
comment on column public.reinforcement.start_min is
  'Scheduled start minute (service-day clock) of the trip right after the empty leg: stable across rebuilds.';
comment on column public.auto_rein_status.start_min is
  'Scheduled start minute (service-day clock) of the automatic-reinforcement ride: stable across rebuilds.';

create or replace function public.save_changes(p_operator uuid, p_changes jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  x jsonb;
  n int := 0;
begin
  if not private.has_role(p_operator, 'editor') then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if octet_length(p_changes::text) > 2000000 then
    raise exception 'too_large';
  end if;

  for x in select * from jsonb_array_elements(coalesce(p_changes->'settings', '[]')) loop
    insert into settings (operator_id, key, value) values (p_operator, x->>'key', x->'value')
      on conflict (operator_id, key) do update set value = excluded.value;
    n := n + 1;
  end loop;

  for x in select * from jsonb_array_elements(coalesce(p_changes->'ovn', '[]')) loop
    if coalesce((x->>'delete')::boolean, false) then
      delete from overnight_override where operator_id = p_operator and day = (x->>'day')::date and veh = x->>'veh';
    else
      insert into overnight_override (operator_id, day, veh, mode, detail, note)
        values (p_operator, (x->>'day')::date, x->>'veh', x->>'mode', x->'detail', x->>'note')
        on conflict (operator_id, day, veh) do update set mode = excluded.mode, detail = excluded.detail, note = excluded.note;
    end if;
    n := n + 1;
  end loop;

  for x in select * from jsonb_array_elements(coalesce(p_changes->'rein', '[]')) loop
    if coalesce((x->>'delete')::boolean, false) then
      delete from reinforcement where operator_id = p_operator and day = (x->>'day')::date and veh = x->>'veh'
        and start_min = (x->>'start_min')::int;
    else
      insert into reinforcement (operator_id, day, veh, start_min, km, line, route_frm, route_to, rein_km, before_km, after_km, note)
        values (p_operator, (x->>'day')::date, x->>'veh', (x->>'start_min')::int, (x->>'km')::numeric, x->>'line',
                x->>'route_frm', x->>'route_to', (x->>'rein_km')::numeric, (x->>'before_km')::numeric, (x->>'after_km')::numeric, x->>'note')
        on conflict (operator_id, day, veh, start_min) do update set km = excluded.km, line = excluded.line,
          route_frm = excluded.route_frm, route_to = excluded.route_to, rein_km = excluded.rein_km,
          before_km = excluded.before_km, after_km = excluded.after_km, note = excluded.note;
    end if;
    n := n + 1;
  end loop;

  for x in select * from jsonb_array_elements(coalesce(p_changes->'autor', '[]')) loop
    if coalesce((x->>'delete')::boolean, false) then
      delete from auto_rein_status where operator_id = p_operator and day = (x->>'day')::date and veh = x->>'veh'
        and start_min = (x->>'start_min')::int;
    else
      insert into auto_rein_status (operator_id, day, veh, start_min, status)
        values (p_operator, (x->>'day')::date, x->>'veh', (x->>'start_min')::int, x->>'status')
        on conflict (operator_id, day, veh, start_min) do update set status = excluded.status;
    end if;
    n := n + 1;
  end loop;

  return jsonb_build_object('saved', n);
end $$;

revoke all on function public.save_changes(uuid, jsonb) from public, anon;
grant execute on function public.save_changes(uuid, jsonb) to authenticated;
