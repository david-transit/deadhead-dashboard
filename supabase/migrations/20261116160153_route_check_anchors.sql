-- Road routing guard (assets/route.js) + station anchor points.
-- road_cache.meta: what the route check saw / did ({v, s:[snap m], fix?, km0?, via?, u?, ok?, why?}); null = legacy row, not checked.
-- settings key 'stop_anchors': [{id, name, stop_lat, stop_lon, lat, lon, note}] per operator (written by editors through
-- save_changes, like every other settings key). No existing row is changed by this migration.
alter table public.road_cache add column if not exists meta jsonb;
alter table public.road_cache drop constraint if exists road_cache_meta_size;
alter table public.road_cache add constraint road_cache_meta_size check (meta is null or octet_length(meta::text) <= 600);
alter table public.settings drop constraint if exists settings_key_check;
alter table public.settings add constraint settings_key_check
  check (key in ('depots', 'fuel_stations', 'driver_change_points', 'defaults', 'vehicles', 'stop_anchors'));
