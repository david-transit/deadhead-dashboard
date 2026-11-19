-- R53 "תכנון מול ביצוע": a correction or explanation on one trip (David 19.11, like the leg notes of the dashboard).
-- Editors and above write and read the operator's notes; the pipeline owner pulls them and fixes the rules/data.
-- No driver names: the trip is identified by day, sidur, vehicle and start minute only.
create table if not exists private.pva_note (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators(id) on delete cascade,
  day date not null,
  sidur text not null,
  veh bigint,
  t0 int not null,
  topic text not null check (topic in ('place', 'km', 'mark', 'other')),
  fix text check (char_length(fix) <= 200),
  body text not null check (char_length(body) between 1 and 2000),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists pva_note_op_day on private.pva_note (operator_id, day);
alter table private.pva_note enable row level security;
revoke all on private.pva_note from public, anon, authenticated;

create or replace function public.add_pva_note(p_operator uuid, p_day date, p_sidur text, p_veh bigint, p_t0 int,
                                               p_topic text, p_fix text, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if not (private.is_active() and private.has_role(p_operator, 'editor')) then raise exception 'not allowed'; end if;
  insert into private.pva_note (operator_id, day, sidur, veh, t0, topic, fix, body)
  values (p_operator, p_day, p_sidur, p_veh, p_t0, p_topic, nullif(btrim(p_fix), ''), btrim(p_body)) returning id into v;
  return v;
end $$;

create or replace function public.pva_notes(p_operator uuid, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when private.has_role(p_operator, 'editor') and p_to >= p_from and p_to - p_from <= 62 then
    coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'day', n.day, 'sidur', n.sidur, 'veh', n.veh, 't0', n.t0,
              'topic', n.topic, 'fix', n.fix, 'body', n.body, 'mine', n.created_by = auth.uid(), 'at', n.created_at) order by n.created_at)
              from private.pva_note n where n.operator_id = p_operator and n.day between p_from and p_to), '[]'::jsonb) end $$;

create or replace function public.delete_pva_note(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.pva_note n where n.id = p_id and private.is_active()
    and (n.created_by = auth.uid() or private.is_platform_admin());
end $$;

revoke all on function public.add_pva_note(uuid, date, text, bigint, int, text, text, text) from public, anon;
revoke all on function public.pva_notes(uuid, date, date) from public, anon;
revoke all on function public.delete_pva_note(uuid) from public, anon;
grant execute on function public.add_pva_note(uuid, date, text, bigint, int, text, text, text) to authenticated;
grant execute on function public.pva_notes(uuid, date, date) to authenticated;
grant execute on function public.delete_pva_note(uuid) to authenticated;
