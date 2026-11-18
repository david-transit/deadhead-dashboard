-- R53 "תכנון מול ביצוע": one plan-vs-actual payload per operator and service day (drivers by code only, no names).
-- Private table, no policies: read only through get_pva / pva_days, which require editor or above (David 18.11:
-- editors for now; later a scoped operator-manager role). Written by the local pipeline (pipeline/pva/build.py SQL).
create table if not exists private.pva_day (
  operator_id uuid not null references public.operators(id) on delete cascade,
  day date not null,
  payload jsonb not null,
  built timestamptz not null default now(),
  primary key (operator_id, day)
);
alter table private.pva_day enable row level security;
revoke all on private.pva_day from public, anon, authenticated;

create or replace function public.get_pva(p_operator uuid, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when private.has_role(p_operator, 'editor') and p_to >= p_from and p_to - p_from <= 62 then
    coalesce((select jsonb_agg(d.payload order by d.day) from private.pva_day d
              where d.operator_id = p_operator and d.day between p_from and p_to), '[]'::jsonb) end $$;

create or replace function public.pva_days(p_operator uuid) returns date[]
language sql stable security definer set search_path = '' as $$
  select case when private.has_role(p_operator, 'editor') then
    coalesce((select array_agg(d.day order by d.day) from private.pva_day d where d.operator_id = p_operator), '{}') end $$;

revoke all on function public.get_pva(uuid, date, date) from public, anon;
revoke all on function public.pva_days(uuid) from public, anon;
grant execute on function public.get_pva(uuid, date, date) to authenticated;
grant execute on function public.pva_days(uuid) to authenticated;

-- Loading a built day: only a platform admin (David, with MFA via is_active), from the page on the local build
-- (plan-actual.html on localhost reads pipeline/cache/pva_<day>.json). No service key on the computer.
create or replace function public.put_pva(p_operator uuid, p_day date, p_payload jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_active() and private.is_platform_admin()) then raise exception 'not allowed'; end if;
  if p_payload->>'day' is distinct from p_day::text then raise exception 'day mismatch'; end if;
  insert into private.pva_day (operator_id, day, payload, built) values (p_operator, p_day, p_payload, now())
  on conflict (operator_id, day) do update set payload = excluded.payload, built = now();
end $$;
revoke all on function public.put_pva(uuid, date, jsonb) from public, anon;
grant execute on function public.put_pva(uuid, date, jsonb) to authenticated;
