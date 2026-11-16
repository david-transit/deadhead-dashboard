-- M1 (security review 2026-11-16): no TRUNCATE / REFERENCES / TRIGGER / MAINTAIN for API roles (TRUNCATE ignores RLS),
-- and new tables / functions / sequences in public are no longer granted to anon/authenticated automatically:
-- every new object must get an explicit, minimal grant in its own migration.
revoke truncate, references, trigger, maintain on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated, public;
-- objects created by supabase_admin (platform internals) keep Supabase's defaults; we never create objects as that role.
