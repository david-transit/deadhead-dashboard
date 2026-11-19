-- Checks for 20261121090000_account_contact_email.sql. One transaction that always ROLLS BACK (ends with 'PASS: ...' as an exception).
-- Same pattern as support_email_rls.sql: an existing active user picked at run time, fake auth claims, nothing stays.
do $$
declare
  u uuid; s uuid := gen_random_uuid(); claims text; ok boolean; n0 int; h0 text; r record;
begin
  select user_id into u from public.profiles where not disabled order by created_at limit 1;
  if u is null then raise exception 'need one active user'; end if;
  insert into auth.sessions (id, user_id, created_at, updated_at) values (s, u, now(), now());
  claims := json_build_object('sub', u, 'role', 'authenticated', 'aal', 'aal2', 'session_id', s)::text;

  -- browser roles (signed-in, even aal2; and anon) reach none of the tables or functions
  for r in select unnest(array['authenticated', 'anon']) as role loop
    execute format('set local role %I', r.role);
    perform set_config('request.jwt.claims', claims, true);
    ok := false; begin perform 1 from private.user_contact_email; exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL % reads user_contact_email', r.role; end if;
    ok := false; begin perform 1 from private.account_mail_log; exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL % reads account_mail_log', r.role; end if;
    ok := false; begin perform 1 from private.details_lock; exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL % reads details_lock', r.role; end if;
    ok := false; begin perform public.contact_email_get(u); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL % calls contact_email_get', r.role; end if;
    ok := false; begin perform public.contact_email_set(u, 'x@y.co', u); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL % calls contact_email_set', r.role; end if;
    ok := false; begin perform public.pw_snapshot(u); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL % calls pw_snapshot', r.role; end if;
    ok := false; begin perform public.pw_restore(u, 'x', true, null); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL % calls pw_restore', r.role; end if;
    ok := false; begin perform public.details_lock(u); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL % calls details_lock', r.role; end if;
    ok := false; begin perform public.account_mail_log_add(u, u, 'sent', null); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL % calls account_mail_log_add', r.role; end if;
    ok := false; begin perform public.contact_email_users(); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL % calls contact_email_users', r.role; end if;
    reset role;
  end loop;

  -- contact email: set, read, list, remove; stored lower-case only
  perform public.contact_email_set(u, 'a@b.co', u);
  if public.contact_email_get(u) is distinct from 'a@b.co' then raise exception 'FAIL contact_email_get'; end if;
  if not exists (select 1 from public.contact_email_users() x where x = u) then raise exception 'FAIL contact_email_users'; end if;
  perform public.contact_email_set(u, null, u);
  if public.contact_email_get(u) is not null then raise exception 'FAIL contact_email_set null did not remove'; end if;
  ok := false; begin insert into private.user_contact_email (user_id, email) values (u, 'Upper@B.co'); exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL upper-case contact email accepted'; end if;

  -- lock: one holder at a time; unlock frees it
  if not public.details_lock(u) then raise exception 'FAIL first lock'; end if;
  if public.details_lock(u) then raise exception 'FAIL second lock granted'; end if;
  perform public.details_unlock(u);
  if not public.details_lock(u) then raise exception 'FAIL lock after unlock'; end if;

  -- quota: a sent account mail counts, a failed one does not
  n0 := public.support_mail_sent_today();
  perform public.account_mail_log_add(u, u, 'sent', null);
  if public.support_mail_sent_today() <> n0 + 1 then raise exception 'FAIL sent account mail not counted'; end if;
  perform public.account_mail_log_add(u, u, 'failed', 'x');
  if public.support_mail_sent_today() <> n0 + 1 then raise exception 'FAIL failed account mail counted'; end if;

  -- snapshot + restore: same hash back, no password_change_not_allowed from the auth.users guard
  select encrypted_password into h0 from auth.users where id = u;
  select * into r from public.pw_snapshot(u);
  update auth.users set encrypted_password = h0 where id = u; -- unchanged value: guard does not fire
  perform public.allow_pw_change(u);
  update auth.users set encrypted_password = extensions.crypt('Other-pw-123', extensions.gen_salt('bf')) where id = u;
  update public.profiles set must_change_password = true, temp_password_expires_at = now() + interval '7 days' where user_id = u;
  perform public.pw_restore(u, r.hash, r.must, r.exp);
  if (select encrypted_password from auth.users where id = u) <> h0 then raise exception 'FAIL pw_restore hash'; end if;
  if (select must_change_password from public.profiles where user_id = u) <> r.must then raise exception 'FAIL pw_restore must'; end if;
  if (select temp_password_expires_at from public.profiles where user_id = u) is distinct from r.exp then raise exception 'FAIL pw_restore exp'; end if;

  -- retention: account mail log older than 12 months goes
  insert into private.account_mail_log (user_id, status, created_at) values (u, 'sent', now() - interval '13 months');
  perform private.support_retention();
  if exists (select 1 from private.account_mail_log where created_at < now() - interval '12 months') then raise exception 'FAIL retention kept old account mail log'; end if;

  raise exception 'PASS: account_mail (rolled back)';
end $$;
