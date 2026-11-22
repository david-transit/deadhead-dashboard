-- Control panel "last activity" (2026-11-22). auth.users.last_sign_in_at changes only on a fresh sign-in (password /
-- code); a user who stays signed in keeps refreshing the token and never moves it (yeoshuan: 19.11 shown, active 21.11).
-- auth.sessions.updated_at moves on every token refresh, i.e. while the user really uses a tool. Sessions are removed on
-- sign-out/expiry, so the sign-in time is kept as the floor: last_active = greatest(last sign-in, latest session update).
create or replace function public.last_activity() returns table (user_id uuid, last_active timestamptz)
language sql stable security definer set search_path = '' as $$
  select u.id, greatest(u.last_sign_in_at, (select max(s.updated_at) from auth.sessions s where s.user_id = u.id))
  from auth.users u $$;
revoke all on function public.last_activity() from public, anon, authenticated;
grant execute on function public.last_activity() to service_role;
