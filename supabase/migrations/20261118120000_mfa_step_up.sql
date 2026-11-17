-- Step-up two-step verification (David, 2026-11-18): operational data works with a password-only session (aal1);
-- the code (aal2) is asked only for the control panel / user management and other sensitive actions.
-- Basis: today the system holds NO personal data (operator schedules and roads only). RULE: when personal data enters
-- the system (e.g. operator files with driver names), re-check this decision and restore aal2 for data
-- (docs: yalla-sa-portal/docs/single-login-design.md, privacy notice/procedure).
--
-- Enforcement after this migration:
--   * manage_users (Edge Function): every control-room action requires aal2 (unchanged); own recovery settings now
--     require aal2 too; change_password / remove_my_mfa require aal2 when the user has a verified factor (unchanged).
--   * RLS: data tables follow private.is_active(), which no longer asks for aal2.
--   * operators UPDATE (platform configuration) requires aal2 (private.is_aal2()).

create or replace function private.mfa_ok() returns boolean
  language sql stable security definer set search_path = '' as $$
  select true $$; -- step-up model: kept as a hook so the rule can be restored in one place

create or replace function private.is_aal2() returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2' $$;
revoke all on function private.is_aal2() from public, anon;
grant execute on function private.is_aal2() to authenticated;

drop policy if exists operators_admin on public.operators;
create policy operators_admin on public.operators for update to authenticated
  using (private.is_platform_admin() and private.is_aal2())
  with check (private.is_platform_admin() and private.is_aal2());
