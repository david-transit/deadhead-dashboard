-- Checks for 20261122100000_support_push.sql. One transaction that always ROLLS BACK (ends with 'PASS: ...' as an exception).
-- Same pattern as support_email_rls.sql: two existing active users picked at run time, fake auth sessions, nothing stays.
do $$
declare
  agent uuid; other uuid; sa uuid := gen_random_uuid(); so uuid := gen_random_uuid(); n int; ok boolean;
begin
  select user_id into agent from public.profiles where not disabled and not must_change_password order by created_at limit 1;
  select user_id into other from public.profiles where user_id <> agent and not disabled and not must_change_password order by created_at limit 1;
  if agent is null or other is null then raise exception 'need two active users'; end if;
  insert into public.support_agents (user_id) values (agent), (other) on conflict do nothing;
  insert into auth.sessions (id, user_id, created_at, updated_at) values (sa, agent, now(), now()), (so, other, now(), now());
  insert into public.support_push_subs (user_id, endpoint, p256dh, auth) values
    (agent, 'https://fcm.googleapis.com/test-a', 'k', 'a'), (other, 'https://fcm.googleapis.com/test-b', 'k', 'a');

  -- a non-agent cannot own a device
  ok := false;
  begin insert into public.support_push_subs (user_id, endpoint, p256dh, auth)
    values (gen_random_uuid(), 'https://fcm.googleapis.com/test-c', 'k', 'a'); exception when foreign_key_violation then ok := true; end;
  if not ok then raise exception 'FAIL device for a non-agent accepted'; end if;
  ok := false;
  begin insert into public.support_push_subs (user_id, endpoint, p256dh, auth) values (agent, 'http://x/y', 'k', 'a');
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL http endpoint accepted'; end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', agent, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sa)::text, true);
  select count(*) into n from public.support_push_subs;
  if n <> 1 then raise exception 'FAIL agent sees % devices, expected own 1', n; end if;
  ok := false;
  begin insert into public.support_push_subs (user_id, endpoint, p256dh, auth) values (agent, 'https://fcm.googleapis.com/test-d', 'k', 'a');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL direct insert allowed'; end if;
  delete from public.support_push_subs where endpoint like 'https://fcm.googleapis.com/test-%';
  reset role;
  if (select count(*) from public.support_push_subs where endpoint like 'https://fcm.googleapis.com/test-%') <> 1 then
    raise exception 'FAIL agent deleted another agent''s device'; end if;

  -- removing the agent removes their devices
  delete from public.support_agents where user_id = other;
  if exists (select 1 from public.support_push_subs where user_id = other) then raise exception 'FAIL devices kept after agent removed'; end if;

  if (select alert_channel from public.support_settings where id = 1) <> 'push' then raise exception 'FAIL channel not push'; end if;
  raise exception 'PASS: support_push (rolled back)';
end $$;
