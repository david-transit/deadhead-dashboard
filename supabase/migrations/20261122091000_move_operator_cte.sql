-- move_operator, review fix (19.11): delete and copy in one statement per table (DELETE ... RETURNING feeds the INSERT),
-- so a grant added at the source while the move runs is either moved or left in place, never dropped. Behaviour unchanged.
create or replace function public.move_operator(p_user uuid, p_from uuid, p_to uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare n int := 0; k int;
begin
  if p_user is null or p_from is null or p_to is null or p_from = p_to then raise exception 'bad_input'; end if;
  if not exists (select 1 from public.operators where id = p_to) then raise exception 'bad_input'; end if;

  with d as (delete from public.memberships where user_id = p_user and operator_id = p_from returning user_id, role, created_by)
  insert into public.memberships as m (user_id, operator_id, role, created_by)
    select user_id, p_to, role, created_by from d
  on conflict (user_id, operator_id) do update
    set role = case when private.role_rank(excluded.role) > private.role_rank(m.role) then excluded.role else m.role end;
  get diagnostics k = row_count; n := n + k;

  with d as (delete from public.tool_roles where user_id = p_user and operator_id = p_from returning user_id, module, role, updated_by)
  insert into public.tool_roles as t (user_id, operator_id, module, role, updated_at, updated_by)
    select user_id, p_to, module, role, now(), updated_by from d
  on conflict (user_id, operator_id, module) do update
    set role = case when private.role_rank(excluded.role) > private.role_rank(t.role) then excluded.role else t.role end,
        updated_at = now();
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;

revoke all on function public.move_operator(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.move_operator(uuid, uuid, uuid) to service_role;
