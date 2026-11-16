-- Accessible vehicles (settings key 'vehicles', field "accessible": true), as David marked them for Derech Egged.
-- Merges into the operator's vehicles settings: other vehicles and other fields of these vehicles stay as they are.
-- 18378904 was confirmed later: migration 20261116162451_seed_accessible_18378904.
insert into public.settings (operator_id, key, value)
select o.id, 'vehicles', '{}'::jsonb from public.operators o where o.slug = 'derech-egged'
on conflict (operator_id, key) do nothing;

update public.settings s
set value = s.value || (
      select jsonb_object_agg(v, coalesce(s.value -> v, '{}'::jsonb) || '{"accessible": true}'::jsonb)
      from unnest(array['18378704', '18378804', '18379004', '18379104', '18379204', '18379304', '18379404']) as v),
    updated_at = now()
from public.operators o
where s.operator_id = o.id and o.slug = 'derech-egged' and s.key = 'vehicles';
