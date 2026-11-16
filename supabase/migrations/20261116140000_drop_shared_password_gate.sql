-- Remove the old shared-password gate (legacy.html). Every user now signs in with a username + password (RLS by role).
-- Only functions are dropped: no table and no row is touched (private.edit_secret / failed_attempts stay as they are).
drop function if exists public.get_data_key(text);
drop function if exists public.check_edit_password(text);
drop function if exists public.has_edit_password();
drop function if exists public.set_edit_password(text, text);
drop function if exists public.get_settings(text);
drop function if exists public.save_setting(text, text, jsonb);
drop function if exists public.get_road_cache(text);
drop function if exists public.put_road_cache(text, jsonb);
drop function if exists public.get_reinforcement(text, date);
drop function if exists public.set_reinforcement(text, date, text, integer, numeric, boolean, text, text, text, numeric, numeric, numeric, text);
drop function if exists public.get_overnight(text, date);
drop function if exists public.set_overnight(text, date, text, text, text);
drop function if exists public.get_auto_rein(text, date);
drop function if exists public.set_auto_rein(text, date, text, integer, text);
drop function if exists private.verify(text);
drop function if exists private.legacy_op();
