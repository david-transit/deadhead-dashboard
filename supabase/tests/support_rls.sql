-- RLS + retention checks for 20261119090000_support_whatsapp.sql. Runs in one transaction and ROLLS BACK: nothing stays.
-- Uses two existing users picked at run time (no fixed ids); raises an exception on the first failed check.
-- On success it ALSO ends with an exception ('PASS: ...'), so the whole block always rolls back, whatever the client does.
do $$
declare
  agent uuid; other uuid; sa uuid := gen_random_uuid(); so uuid := gen_random_uuid(); c uuid; v_old uuid; v_new uuid; n int; ok boolean;
  claims_agent1 text; claims_agent2 text; claims_other2 text;
begin
  select user_id into agent from public.profiles where not disabled and not must_change_password order by created_at limit 1;
  select user_id into other from public.profiles where user_id <> agent and not disabled and not must_change_password order by created_at limit 1;
  if agent is null or other is null then raise exception 'need two active users'; end if;
  insert into public.support_agents (user_id) values (agent) on conflict do nothing;
  delete from public.support_agents where user_id = other;
  -- private.is_active() also needs a live Auth session (private.session_alive): one fake session per user, rolled back
  insert into auth.sessions (id, user_id, created_at, updated_at) values (sa, agent, now(), now()), (so, other, now(), now());

  insert into public.support_contacts (wa_id, wa_name) values ('972500000001', 'בדיקה') returning id into c;
  insert into public.support_contacts (wa_id, opted_out_at) values ('972500000002', now());
  insert into public.support_conversations (contact_id, status, closed_at) values (c, 'closed', now() - interval '13 months') returning id into v_old;
  insert into public.support_conversations (contact_id, status, closed_at) values (c, 'closed', now() - interval '11 months') returning id into v_new;
  insert into public.support_messages (conversation_id, contact_id, direction, sender, body) values (v_old, c, 'in', 'contact', 'ישן');

  claims_agent1 := json_build_object('sub', agent, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sa)::text;
  claims_agent2 := json_build_object('sub', agent, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sa)::text;
  claims_other2 := json_build_object('sub', other, 'role', 'authenticated', 'aal', 'aal2', 'session_id', so)::text;

  set local role authenticated;
  perform set_config('request.jwt.claims', claims_agent1, true);
  select count(*) into n from public.support_conversations;
  if n <> 0 then raise exception 'FAIL agent aal1 sees % conversations', n; end if;

  perform set_config('request.jwt.claims', claims_agent2, true);
  select count(*) into n from public.support_conversations;
  if n < 2 then raise exception 'FAIL agent aal2 sees % conversations', n; end if;
  if not public.support_is_agent() then raise exception 'FAIL support_is_agent false for agent'; end if;

  perform set_config('request.jwt.claims', claims_other2, true);
  select count(*) into n from public.support_messages;
  if n <> 0 then raise exception 'FAIL non-agent sees % messages', n; end if;
  if public.support_is_agent() then raise exception 'FAIL support_is_agent true for non-agent'; end if;

  perform set_config('request.jwt.claims', claims_agent2, true);
  ok := false;
  begin insert into public.support_contacts (wa_id) values ('972500000003'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL direct insert allowed'; end if;
  ok := false;
  begin perform public.support_month_spend(); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL support_month_spend callable by authenticated'; end if;
  if not exists (select 1 from public.platform_admins where user_id = agent) then
    ok := false;
    begin perform public.support_save_settings('{"monthly_cap_ils": 99}'); exception when others then ok := true; end;
    if not ok then raise exception 'FAIL non-admin agent saved settings'; end if;
  end if;

  reset role;
  perform private.support_retention();
  if exists (select 1 from public.support_conversations where id = v_old) then raise exception 'FAIL 13-month conversation kept'; end if;
  if not exists (select 1 from public.support_conversations where id = v_new) then raise exception 'FAIL 11-month conversation deleted'; end if;
  if not exists (select 1 from public.support_contacts where wa_id = '972500000002') then raise exception 'FAIL opted-out contact deleted'; end if;
  if not public.support_mark_alert('warn80') then raise exception 'FAIL first alert'; end if;
  if public.support_mark_alert('warn80') then raise exception 'FAIL second alert same month'; end if;
  raise exception 'PASS: ALL SUPPORT RLS CHECKS PASSED (rolled back)';
end $$;
