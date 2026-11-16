-- Notes on empty legs (day legs and overnight legs): free-text feedback from operator users to the product team.
-- Insert by editor+ (only as yourself); read by platform admins, and by the author (to show "נשלח"). Not shown to other
-- operators' users. Written through save_changes (drafts, key "notes"). No existing row is changed.
create table public.leg_notes (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id) on delete cascade,
  day date not null,
  veh text not null check (length(veh) <= 40),
  leg_start_min int not null check (leg_start_min between -1440 and 4320),
  kind text not null check (kind in ('day', 'overnight')),
  text text not null check (length(trim(text)) between 1 and 2000),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);
create index leg_notes_day on public.leg_notes (operator_id, day);
alter table public.leg_notes enable row level security;
create policy leg_notes_read on public.leg_notes for select to authenticated
  using (private.is_platform_admin() or created_by = (select auth.uid()));
create policy leg_notes_insert on public.leg_notes for insert to authenticated
  with check (private.has_role(operator_id, 'editor') and created_by = (select auth.uid()));
revoke all on public.leg_notes from anon;
revoke update, delete on public.leg_notes from authenticated;
grant select, insert on public.leg_notes to authenticated;

-- save_changes: also leg notes (key "notes": {id, day, veh, leg_start_min, kind, text}; insert only)
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

  for x in select * from jsonb_array_elements(coalesce(p_changes->'blk', '[]')) loop
    if coalesce((x->>'delete')::boolean, false) then
      delete from block_edits where operator_id = p_operator and id = (x->>'id')::uuid;
    else
      insert into block_edits (id, operator_id, day, veh, action, payload, note)
        values ((x->>'id')::uuid, p_operator, (x->>'day')::date, x->>'veh', x->>'action', x->'payload', x->>'note')
        on conflict (id) do update set payload = excluded.payload, note = excluded.note
        where block_edits.operator_id = p_operator;
    end if;
    n := n + 1;
  end loop;

  for x in select * from jsonb_array_elements(coalesce(p_changes->'notes', '[]')) loop
    insert into leg_notes (id, operator_id, day, veh, leg_start_min, kind, text)
      values ((x->>'id')::uuid, p_operator, (x->>'day')::date, x->>'veh', (x->>'leg_start_min')::int, x->>'kind', x->>'text')
      on conflict (id) do nothing;
    n := n + 1;
  end loop;

  return jsonb_build_object('saved', n);
end $$;

revoke all on function public.save_changes(uuid, jsonb) from public, anon;
grant execute on function public.save_changes(uuid, jsonb) to authenticated;
