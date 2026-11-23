-- Checks for 20261123130000_route_live_check.sql. One transaction that always ROLLS BACK (ends with 'PASS: ...' as an exception).
-- A viewer and an editor of one operator are made at run time (fake auth sessions); nothing stays.
do $$
declare
  op uuid; ed uuid; vw uuid; se uuid := gen_random_uuid(); sv uuid := gen_random_uuid(); n int; ok boolean; r record;
begin
  select id into op from public.operators order by id limit 1;
  select user_id into ed from public.profiles where not disabled and user_id not in (select user_id from public.platform_admins) order by created_at limit 1;
  select user_id into vw from public.profiles where not disabled and user_id <> ed and user_id not in (select user_id from public.platform_admins) order by created_at limit 1;
  if op is null or ed is null or vw is null then raise exception 'need an operator and two users'; end if;
  delete from public.memberships where user_id in (ed, vw) and operator_id = op;
  insert into public.memberships (user_id, operator_id, role) values (ed, op, 'editor'), (vw, op, 'viewer');
  insert into auth.sessions (id, user_id, created_at, updated_at) values (se, ed, now(), now()), (sv, vw, now(), now());

  -- no column for anything from Google
  for r in select column_name from information_schema.columns where table_schema = 'public' and table_name = 'route_km_manual' loop
    if r.column_name ~ '(google|gkm|g_km|gmaps)' then raise exception 'FAIL Google column %', r.column_name; end if;
  end loop;

  set local role authenticated;
  -- editor: has the capability, may type a km; who / when are set by the DB
  perform set_config('request.jwt.claims', json_build_object('sub', ed, 'role', 'authenticated', 'aal', 'aal1', 'session_id', se)::text, true);
  if not public.can_verify_route(op) then raise exception 'FAIL editor lacks the capability'; end if;
  insert into public.route_km_manual (operator_id, a_lat, a_lon, b_lat, b_lon, km, our_km, origin, destination, created_by, created_at)
    values (op, 31.76635, 35.14881, 31.79996, 35.14805, 6.2, 10.0, 'א', 'ב', vw, '2020-01-01');
  select count(*) into n from public.route_km_manual where operator_id = op and created_by = ed and created_at > now() - interval '1 minute';
  if n <> 1 then raise exception 'FAIL who / when not set by the DB'; end if;
  ok := false;
  begin update public.route_km_manual set km = 1 where operator_id = op; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL update allowed (change = delete + insert)'; end if;
  insert into public.route_ok (operator_id, a_lat, a_lon, b_lat, b_lon, km, origin, destination)
    values (op, 31.76635, 35.14881, 31.79996, 35.14805, 10.0, 'א', 'ב') on conflict do nothing;

  -- viewer: reads, cannot type a km, approve or check
  perform set_config('request.jwt.claims', json_build_object('sub', vw, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sv)::text, true);
  if public.can_verify_route(op) then raise exception 'FAIL viewer has the capability'; end if;
  select count(*) into n from public.route_km_manual where operator_id = op;
  if n < 1 then raise exception 'FAIL viewer cannot read the typed km'; end if;
  ok := false;
  begin insert into public.route_km_manual (operator_id, a_lat, a_lon, b_lat, b_lon, km, our_km) values (op, 31.7, 35.1, 31.8, 35.2, 3, 4);
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL viewer typed a km'; end if;
  ok := false;
  begin insert into public.route_ok (operator_id, a_lat, a_lon, b_lat, b_lon, km) values (op, 31.7, 35.1, 31.8, 35.2, 4);
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL viewer approved a route'; end if;
  delete from public.route_km_manual where operator_id = op;
  reset role;
  if not exists (select 1 from public.route_km_manual where operator_id = op and created_by = ed) then raise exception 'FAIL viewer deleted a typed km'; end if;

  -- the editor's name is listed for "מי"
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', vw, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sv)::text, true);
  if not exists (select 1 from public.edit_authors(op) where user_id = ed) then raise exception 'FAIL author name missing'; end if;
  -- anon: nothing
  reset role;
  set local role anon;
  ok := false;
  begin perform 1 from public.route_km_manual limit 1; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL anon reads route_km_manual'; end if;
  reset role;
  raise exception 'PASS: route_live_check (rolled back)';
end $$;
