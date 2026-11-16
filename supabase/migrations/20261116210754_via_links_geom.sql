-- via_links.geom: the link's road line ([[lat,lon],...] from a to b) so the map draws the real road instead of a straight
-- line. Display only (routing uses a, b and link_km). Changing it on an approved link clears the approval like a change of
-- a, b, link_km or both_ways (guard_via_link), unless a platform admin makes the change. No existing row is changed here.
alter table public.via_links add column if not exists geom jsonb
  check (geom is null or (jsonb_typeof(geom) = 'array' and octet_length(geom::text) <= 20000));

create or replace function private.guard_via_link() returns trigger language plpgsql security definer set search_path = '' as $$
declare admin boolean := private.is_platform_admin();
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_at := now();
  else
    new.created_by := old.created_by; new.created_at := old.created_at; new.operator_id := old.operator_id;
  end if;
  if new.approved_at is not null and (tg_op = 'INSERT' or old.approved_at is null) then      -- approving
    if not admin then raise exception 'not_allowed'; end if;
    new.approved_by := auth.uid(); new.approved_at := now();
    new.approved_name := (select coalesce(nullif(p.display_name, ''), p.username) from public.profiles p where p.user_id = auth.uid());
  elsif tg_op = 'UPDATE' and old.approved_at is not null then
    if (new.a_lat, new.a_lon, new.b_lat, new.b_lon, new.link_km, new.both_ways, new.geom) is distinct from
       (old.a_lat, old.a_lon, old.b_lat, old.b_lon, old.link_km, old.both_ways, old.geom) and not admin then
      new.approved_by := null; new.approved_name := null; new.approved_at := null;            -- changed: needs approval again
    elsif new.approved_at is null and not admin then raise exception 'not_allowed';             -- only an admin withdraws approval
    elsif new.approved_at is not null then
      new.approved_by := old.approved_by; new.approved_name := old.approved_name; new.approved_at := old.approved_at;
    end if;
  else
    new.approved_by := null; new.approved_name := null; new.approved_at := null;
  end if;
  return new;
end $$;
revoke all on function private.guard_via_link() from public, anon, authenticated;

-- Data (run separately as SQL, 2026-11-16): האיילות link 89269be5 geom = OSM ways 424808014 + 1015330762 (48 points,
-- 1.14 km). The link was not approved at that time (approval had been cleared when both_ways was set), so nothing else changed.
