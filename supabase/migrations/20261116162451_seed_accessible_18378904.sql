-- David confirmed 18378904 as accessible too (8 vehicles in all). Merges into the vehicles settings like the previous seed.
update public.settings s
set value = s.value || jsonb_build_object('18378904', coalesce(s.value -> '18378904', '{}'::jsonb) || '{"accessible": true}'::jsonb), updated_at = now()
from public.operators o
where s.operator_id = o.id and o.slug = 'derech-egged' and s.key = 'vehicles';
