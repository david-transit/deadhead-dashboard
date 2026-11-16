-- Manual block edits (fixing data errors): each row is one override on (operator, day, vehicle): delete / replace /
-- add / times / move a trip. The original day file never changes; the dashboard (assets/core.js applyBlockEdits)
-- applies the rows in created_at order and recomputes everything from the edited block. Revert = delete the row.
-- Written only through save_changes (drafts). No existing row is changed.
create table public.block_edits (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id) on delete cascade,
  day date not null,
  veh text not null check (length(veh) <= 40),
  action text not null check (action in ('delete', 'replace', 'add', 'times', 'move')),
  payload jsonb not null check (octet_length(payload::text) <= 8000),
  note text check (length(note) <= 300),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz
);
create index block_edits_day on public.block_edits (operator_id, day);
create trigger stamp before insert or update on public.block_edits for each row execute function private.stamp();
alter table public.block_edits enable row level security;
create policy block_edits_read on public.block_edits for select to authenticated using (private.has_role(operator_id, 'viewer'));
create policy block_edits_insert on public.block_edits for insert to authenticated with check (private.has_role(operator_id, 'editor'));
create policy block_edits_update on public.block_edits for update to authenticated using (private.has_role(operator_id, 'editor')) with check (private.has_role(operator_id, 'editor'));
create policy block_edits_delete on public.block_edits for delete to authenticated using (private.has_role(operator_id, 'editor'));
revoke all on public.block_edits from anon;
grant select, insert, update, delete on public.block_edits to authenticated;

-- save_changes: also the block edits (key "blk": {id, day, veh, action, payload, note} or {id, delete:true})
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

  return jsonb_build_object('saved', n);
end $$;

revoke all on function public.save_changes(uuid, jsonb) from public, anon;
grant execute on function public.save_changes(uuid, jsonb) to authenticated;
