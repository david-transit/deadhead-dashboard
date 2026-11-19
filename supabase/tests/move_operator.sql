-- Checks for 20261122090000_move_operator.sql. One transaction that always ROLLS BACK (ends with 'PASS: ...' as an exception).
do $$
declare u uuid; a uuid; b uuid; n int;
begin
  select user_id into u from public.profiles where not disabled order by created_at limit 1;
  if u is null then raise exception 'need one active user'; end if;
  insert into public.operators (slug, name) values ('zz-move-a', 'בדיקה א') returning id into a;
  insert into public.operators (slug, name) values ('zz-move-b', 'בדיקה ב') returning id into b;
  insert into public.memberships (user_id, operator_id, role) values (u, a, 'editor'), (u, b, 'admin');
  insert into public.tool_roles (user_id, operator_id, module, role) values (u, a, 'studio', 'viewer');

  -- browser roles cannot call it
  if has_function_privilege('anon', 'public.move_operator(uuid,uuid,uuid)', 'execute') then raise exception 'FAIL anon may call move_operator'; end if;
  if has_function_privilege('authenticated', 'public.move_operator(uuid,uuid,uuid)', 'execute') then raise exception 'FAIL authenticated may call move_operator'; end if;

  n := public.move_operator(u, a, b);
  if n <> 2 then raise exception 'FAIL moved % rows, expected 2', n; end if;
  if (select role from public.memberships where user_id = u and operator_id = b) <> 'admin' then raise exception 'FAIL higher role not kept'; end if;
  if (select role from public.tool_roles where user_id = u and operator_id = b and module = 'studio') is distinct from 'viewer' then raise exception 'FAIL studio role not moved'; end if;
  if exists (select 1 from public.memberships where user_id = u and operator_id = a)
     or exists (select 1 from public.tool_roles where user_id = u and operator_id = a) then raise exception 'FAIL rows left in source operator'; end if;

  -- same operator twice is refused
  begin perform public.move_operator(u, b, b); raise exception 'FAIL same operator accepted';
  exception when raise_exception then if sqlerrm <> 'bad_input' then raise; end if; end;

  raise exception 'PASS: move_operator (rolled back)';
end $$;
