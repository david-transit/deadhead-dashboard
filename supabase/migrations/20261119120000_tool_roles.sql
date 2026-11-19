-- tool_roles (yalla-sa): a role per tool, so the planning tool (studio) no longer shares the deadhead role.
-- Bug (2026-11-19): the control panel's "permissions per tool" matrix wrote both tools' roles into memberships.role,
-- so changing one tool's role changed the other. From here:
--   memberships.role             = the deadhead tool's role at that operator (unchanged; all deadhead RLS keeps using it)
--                                  and, as today, an operator 'admin' there is the operator's user manager in the panel
--   tool_roles(user, op, module) = the role in every other live tool (today only 'studio'); no row = no access
-- A tool role does not need a deadhead membership: a user may have the planning tool only.
-- Written only by manage_users (service role); read by the user (own rows), by operator admins (their operator)
-- and by tool_access (service role) for transit-studio.
-- When the identity migration (membership_modules) is approved, these rows move there and this table is dropped.

begin;

create table public.tool_roles (
  user_id uuid not null references auth.users (id) on delete cascade,
  operator_id uuid not null references public.operators (id) on delete cascade,
  module text not null check (module ~ '^[a-z0-9-]{2,40}$' and module <> 'deadhead'),
  role text not null check (role in ('viewer', 'editor', 'admin')),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (user_id, operator_id, module)
);
create index tool_roles_op_idx on public.tool_roles (operator_id, module);

-- keep today's access: until now the planning tool used the deadhead role, so every member starts with the same level
insert into public.tool_roles (user_id, operator_id, module, role)
  select m.user_id, m.operator_id, 'studio', m.role from public.memberships m;

alter table public.tool_roles enable row level security;
create policy tool_roles_read on public.tool_roles for select to authenticated
  using ((user_id = (select auth.uid()) and private.is_active()) or private.has_role(operator_id, 'admin'));
revoke all on public.tool_roles from anon, authenticated;
grant select on public.tool_roles to authenticated;

commit;
