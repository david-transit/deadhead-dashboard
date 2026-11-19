-- Checks for 20261120090000_support_email.sql. One transaction that always ROLLS BACK (ends with 'PASS: ...' as an exception).
-- Same pattern as support_rls.sql: two existing active users picked at run time, fake auth sessions, nothing stays.
do $$
declare
  agent uuid; other uuid; sa uuid := gen_random_uuid(); so uuid := gen_random_uuid();
  ce uuid; cs uuid; ve uuid; vs uuid; n int; ok boolean; day0 timestamptz;
  claims_agent1 text; claims_agent2 text; claims_other2 text;
begin
  select user_id into agent from public.profiles where not disabled and not must_change_password order by created_at limit 1;
  select user_id into other from public.profiles where user_id <> agent and not disabled and not must_change_password order by created_at limit 1;
  if agent is null or other is null then raise exception 'need two active users'; end if;
  insert into public.support_agents (user_id) values (agent) on conflict do nothing;
  delete from public.support_agents where user_id = other;
  insert into auth.sessions (id, user_id, created_at, updated_at) values (sa, agent, now(), now()), (so, other, now(), now());

  -- identity: email only is fine; neither wa_id nor email fails; upper-case email fails
  insert into public.support_contacts (email, email_name) values ('test-mail@example.com', 'בדיקה') returning id into ce;
  ok := false;
  begin insert into public.support_contacts (email_name) values ('x'); exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL contact without wa_id and email accepted'; end if;
  ok := false;
  begin insert into public.support_contacts (email) values ('Upper@Example.com'); exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL upper-case email accepted'; end if;

  -- channel default stays whatsapp (wa_webhook does not set it)
  insert into public.support_contacts (wa_id) values ('972500000011') returning id into cs;
  insert into public.support_conversations (contact_id) values (cs) returning id into vs;
  if (select channel from public.support_conversations where id = vs) <> 'whatsapp' then raise exception 'FAIL conversation channel default'; end if;
  insert into public.support_messages (conversation_id, contact_id, direction, sender, body) values (vs, cs, 'in', 'contact', 'x');
  if exists (select 1 from public.support_messages where conversation_id = vs and channel <> 'whatsapp') then raise exception 'FAIL message channel default'; end if;

  insert into public.support_conversations (contact_id, channel, subject) values (ce, 'email', 'נושא') returning id into ve;
  day0 := date_trunc('day', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem';
  insert into public.support_messages (conversation_id, contact_id, direction, sender, body, channel, status, created_at)
  values (ve, ce, 'out', 'agent', 'today', 'email', 'sent', day0 + interval '1 minute'),
         (ve, ce, 'out', 'agent', 'yesterday', 'email', 'sent', day0 - interval '1 minute');
  if public.support_mail_sent_today() <> 1 then raise exception 'FAIL mail_sent_today = %', public.support_mail_sent_today(); end if;

  claims_agent1 := json_build_object('sub', agent, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sa)::text;
  claims_agent2 := json_build_object('sub', agent, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sa)::text;
  claims_other2 := json_build_object('sub', other, 'role', 'authenticated', 'aal', 'aal2', 'session_id', so)::text;

  set local role authenticated;
  perform set_config('request.jwt.claims', claims_agent1, true);
  select count(*) into n from public.support_conversations where id = ve;
  if n <> 0 then raise exception 'FAIL agent aal1 sees the email conversation'; end if;
  select count(*) into n from storage.objects where bucket_id = 'support-attachments';
  if n <> 0 then raise exception 'FAIL agent aal1 sees attachments'; end if;
  ok := false;
  begin perform public.support_mark_spam(ve); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL mark_spam allowed at aal1'; end if;

  perform set_config('request.jwt.claims', claims_other2, true);
  select count(*) into n from public.support_conversations where id = ve;
  if n <> 0 then raise exception 'FAIL non-agent sees the email conversation'; end if;

  perform set_config('request.jwt.claims', claims_agent2, true);
  select count(*) into n from public.support_conversations where id = ve;
  if n <> 1 then raise exception 'FAIL agent aal2 does not see the email conversation'; end if;
  ok := false;
  begin perform public.support_mail_sent_today(); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL support_mail_sent_today callable by authenticated'; end if;
  perform public.support_mark_spam(ve);

  reset role;
  if (select status from public.support_conversations where id = ve) <> 'closed' then raise exception 'FAIL spam did not close'; end if;
  if (select blocked_at from public.support_contacts where id = ce) is null then raise exception 'FAIL spam did not block'; end if;

  -- retention keeps a blocked contact even with nothing left
  delete from public.support_conversations where contact_id = ce;
  perform private.support_retention();
  if not exists (select 1 from public.support_contacts where id = ce) then raise exception 'FAIL blocked contact deleted by retention'; end if;

  -- save_settings (as service role / postgres bypasses the admin check only via direct update; check the alert_to consent block with an admin if one exists)
  if exists (select 1 from public.platform_admins pa where pa.user_id = agent) then
    set local role authenticated;
    perform set_config('request.jwt.claims', claims_agent2, true);
    perform public.support_save_settings('{"alert_to":"972500000012","alert_email":" David@Example.com "}');
    reset role;
    if (select consent_at from public.support_contacts where wa_id = '972500000012') is null then raise exception 'FAIL alert_to consent block lost'; end if;
    if (select alert_email from public.support_settings where id = 1) <> 'david@example.com' then raise exception 'FAIL alert_email not normalized'; end if;
  end if;

  raise exception 'PASS: support_email (rolled back)';
end $$;
