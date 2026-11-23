-- R53 "תכנון מול ביצוע": no driver data at all (David 23.11.2026: "נתייחס רק למספר סידור ומספר רכב בלי שם נהג וגם בלי
-- מספר נהג"). Removes every "driver" / "drivers" key, at any depth, from the stored day payloads, and makes put_pva refuse a
-- payload that still carries one. Sidurim are never deleted ("לא מוחקים סידורים בשום אופן"): only those keys go; the sidur
-- and vehicle numbers, trips and every other field stay as they are.
-- Run on the live database only after the PR is merged and with David's approval.

create or replace function private.pva_strip_driver(j jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
begin
  return case jsonb_typeof(j)
    when 'object' then coalesce((select jsonb_object_agg(e.k, private.pva_strip_driver(e.v))
                                 from jsonb_each(j) as e(k, v) where e.k not in ('driver', 'drivers')), '{}'::jsonb)
    when 'array' then coalesce((select jsonb_agg(private.pva_strip_driver(a.v) order by a.i)
                                from jsonb_array_elements(j) with ordinality as a(v, i)), '[]'::jsonb)
    else j end;
end $$;
revoke all on function private.pva_strip_driver(jsonb) from public, anon, authenticated;

-- The vehicle-review hint used to say "maybe the vehicle or the driver changed"; the new build says "maybe the vehicle changed".
update private.pva_day
   set payload = replace(private.pva_strip_driver(payload)::text, '. אולי הוחלף רכב או נהג; צריך לברר', '. אולי הוחלף רכב; צריך לברר')::jsonb
 where payload::text ~ '"drivers?":' or payload::text like '%אולי הוחלף רכב או נהג%';

do $$
declare n int; s int;
begin
  select count(*) into n from private.pva_day where payload::text ~ '"drivers?":';
  if n > 0 then raise exception 'driver keys left in % pva_day rows', n; end if;
  -- nothing else may be lost: every stored day keeps its sidurim
  select count(*) into s from private.pva_day where jsonb_typeof(payload->'sidurim') is distinct from 'array';
  if s > 0 then raise exception '% pva_day rows lost their sidurim', s; end if;
end $$;

-- Loading a built day: same rules as before (platform admin with MFA, day must match), and no driver key at any depth.
create or replace function public.put_pva(p_operator uuid, p_day date, p_payload jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_active() and private.is_platform_admin()) then raise exception 'not allowed'; end if;
  if p_payload->>'day' is distinct from p_day::text then raise exception 'day mismatch'; end if;
  if p_payload::text ~ '"drivers?":' then raise exception 'driver data is not allowed (R53)'; end if;
  insert into private.pva_day (operator_id, day, payload, built) values (p_operator, p_day, p_payload, now())
  on conflict (operator_id, day) do update set payload = excluded.payload, built = now();
end $$;
revoke all on function public.put_pva(uuid, date, jsonb) from public, anon;
grant execute on function public.put_pva(uuid, date, jsonb) to authenticated;
