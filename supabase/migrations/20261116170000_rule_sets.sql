-- Savings-engine rules: operator defaults + per-line overrides (savings/engine.js RULES_META).
-- One row per (operator, scope, line_key); line_key = '' for the operator row. Values not stored = engine defaults.
-- RLS like the other operator tables: read = operator members (viewer+), write = editor+; platform admin passes has_role.
create table if not exists public.rule_sets (
  operator_id uuid not null references public.operators(id) on delete cascade,
  scope text not null check (scope in ('operator', 'line')),
  line_key text not null default '' check (char_length(line_key) <= 40),
  rules jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object' and octet_length(rules::text) <= 20000),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (operator_id, scope, line_key),
  check ((scope = 'operator') = (line_key = ''))
);
comment on table public.rule_sets is 'Savings-suggestion rules per operator (scope operator) with per-line overrides (scope line).';

create trigger stamp before insert or update on public.rule_sets for each row execute function private.stamp();

alter table public.rule_sets enable row level security;
create policy rule_sets_read on public.rule_sets for select to authenticated using (private.has_role(operator_id, 'viewer'));
create policy rule_sets_insert on public.rule_sets for insert to authenticated with check (private.has_role(operator_id, 'editor'));
create policy rule_sets_update on public.rule_sets for update to authenticated
  using (private.has_role(operator_id, 'editor')) with check (private.has_role(operator_id, 'editor'));
create policy rule_sets_delete on public.rule_sets for delete to authenticated using (private.has_role(operator_id, 'editor'));
revoke all on public.rule_sets from anon;
grant select, insert, update, delete on public.rule_sets to authenticated;

-- Save the whole rule set at once (the panel's "שמירה"): operator row + every line override; lines not sent are removed.
-- security invoker: the RLS above applies to every row.
create or replace function public.save_rule_set(p_operator uuid, p_operator_rules jsonb, p_lines jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  k text;
  n int := 0;
begin
  if not private.has_role(p_operator, 'editor') then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_operator_rules, '{}')) <> 'object' or jsonb_typeof(coalesce(p_lines, '{}')) <> 'object' then
    raise exception 'bad_input';
  end if;
  if octet_length(coalesce(p_lines, '{}')::text) > 500000 then
    raise exception 'too_large';
  end if;
  insert into rule_sets (operator_id, scope, line_key, rules)
    values (p_operator, 'operator', '', coalesce(p_operator_rules, '{}'))
    on conflict (operator_id, scope, line_key) do update set rules = excluded.rules;
  n := 1;
  delete from rule_sets where operator_id = p_operator and scope = 'line'
    and not (line_key = any (array(select jsonb_object_keys(coalesce(p_lines, '{}')))));
  for k in select jsonb_object_keys(coalesce(p_lines, '{}')) loop
    insert into rule_sets (operator_id, scope, line_key, rules)
      values (p_operator, 'line', k, p_lines->k)
      on conflict (operator_id, scope, line_key) do update set rules = excluded.rules;
    n := n + 1;
  end loop;
  return jsonb_build_object('saved', n);
end $$;

revoke all on function public.save_rule_set(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.save_rule_set(uuid, jsonb, jsonb) to authenticated;
