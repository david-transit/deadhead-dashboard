-- L4 fix (found by the re-run of the review checks): removing ALL platform admins at once left the table empty and the
-- old check ("exists any admin and none active") passed. After the one-time bootstrap, zero active admins is refused.
create or replace function private.keep_platform_admin() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('yalla-sa:platform_admins'));
  if exists (select 1 from private.bootstrap) and not exists (
       select 1 from public.platform_admins a join public.profiles p on p.user_id = a.user_id where not p.disabled) then
    raise exception 'last_platform_admin';
  end if;
  return null;
end $$;
