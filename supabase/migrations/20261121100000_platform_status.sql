-- Platform status (yalla-sa control panel tab "מצב הפלטפורמה").
-- Spec: yalla-sa-support/docs/superpowers/specs/2026-11-19-platform-status-design.md §4. No cron here (see ..101000).
-- Needs, before: 20261121090000_account_contact_email.sql (private.account_mail_log, counted by support_mail_sent_month).
-- Needs: the Vault secret 'support_internal_key' (already there) and the Edge Function platform_status (verify_jwt off).
-- Holds numbers and fixed text only: no names, phones or addresses.

create table private.status_items (
  key text primary key,
  ord int not null,
  grp text not null check (grp in ('cost','free','runs','manual')),
  title text not null,
  explain text not null,
  value numeric,
  cap numeric,
  level text not null check (level in ('ok','warn','bad','unknown','manual')),
  reading text not null,
  note text,
  link text,
  checked_at timestamptz not null,
  unknown_since timestamptz,
  red_since timestamptz
);

create table private.status_manual (
  key text primary key check (key like 'm\_%'),
  checked_on date,
  checked_by uuid
);
insert into private.status_manual(key, checked_on) values
  ('m_cloudflare', current_date), ('m_supabase', current_date), ('m_meta', current_date),
  ('m_google_billing', current_date), ('m_planner', current_date);

create table private.status_meta (
  id int primary key default 1 check (id = 1),
  last_digest_on date,
  last_refresh_at timestamptz,
  running_until timestamptz   -- one check at a time (cron + "בדיקה עכשיו" must not both send the same red message)
);
insert into private.status_meta(id) values (1);

-- monthly twin of support_mail_sent_today(): the same mails, from the start of the month (Israel time)
create or replace function public.support_mail_sent_month() returns integer
  language sql stable security definer set search_path = '' as $$
  with d as (select (date_trunc('month', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem') as t0)
  select ((select count(*) from public.support_messages, d
           where channel = 'email' and direction = 'out' and status = 'sent' and created_at >= d.t0)
        + (select count(*) from private.account_mail_log, d where status = 'sent' and created_at >= d.t0))::int $$;

-- every number the hourly check needs, in one call (server only)
create or replace function public.status_figures() returns jsonb
  language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'wa_spend', public.support_month_spend(),
    'wa_cap', (select monthly_cap_ils from public.support_settings where id = 1),
    'g_month', coalesce((select n from public.google_usage where period = to_char(now() at time zone 'utc', 'YYYY-MM')), 0),
    'g_day', coalesce((select n from public.google_usage where period = to_char(now() at time zone 'utc', 'YYYY-MM-DD')), 0),
    'mail_day', public.support_mail_sent_today(),
    'mail_month', public.support_mail_sent_month(),
    'mail_cap', coalesce((select mail_daily_cap from public.support_settings where id = 1), 100),
    'db_bytes', pg_database_size(current_database()),
    'alert_channel', coalesce((select alert_channel from public.support_settings where id = 1), 'off'),
    'manual', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'checked_on', checked_on)) from private.status_manual), '[]'::jsonb)) $$;

-- run lease: true for the one caller that may run now; the lease ends by itself after 90 seconds
create or replace function public.status_run_begin() returns boolean
  language plpgsql security definer set search_path = '' as $$
begin
  update private.status_meta set running_until = now() + interval '90 seconds'
    where id = 1 and (running_until is null or running_until < now());
  return found;
end $$;
create or replace function public.status_run_end() returns void
  language sql security definer set search_path = '' as $$
  update private.status_meta set running_until = null where id = 1 $$;

-- the hourly check reads and writes the snapshot through these two (the private schema is not exposed to the API)
create or replace function public.status_snapshot_get() returns jsonb
  language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.ord) from private.status_items i), '[]'::jsonb),
    'last_digest_on', (select last_digest_on from private.status_meta where id = 1)) $$;

create or replace function public.status_snapshot_put(p_items jsonb, p_digest_on date) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  insert into private.status_items
    select * from jsonb_populate_recordset(null::private.status_items, p_items)
  on conflict (key) do update set ord = excluded.ord, grp = excluded.grp, title = excluded.title, explain = excluded.explain,
    value = excluded.value, cap = excluded.cap, level = excluded.level, reading = excluded.reading, note = excluded.note,
    link = excluded.link, checked_at = excluded.checked_at, unknown_since = excluded.unknown_since, red_since = excluded.red_since;
  if p_digest_on is not null then update private.status_meta set last_digest_on = p_digest_on where id = 1; end if;
end $$;

create or replace function private.status_call() returns void
  language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'support_internal_key';
  if k is null then raise warning 'platform_status: vault secret support_internal_key missing'; return; end if;
  perform net.http_post(
    url := 'https://xghfcdgettrcdciwwzbl.supabase.co/functions/v1/platform_status',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-key', k),
    timeout_milliseconds := 60000);
end $$;

-- the panel: platform admins in an aal2 session only
create or replace function private.status_guard() returns void
  language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() or coalesce(auth.jwt()->>'aal', '') <> 'aal2' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

create or replace function public.platform_status() returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.status_guard();
  return jsonb_build_object(
    'checked_at', (select max(checked_at) from private.status_items),
    'alert_channel', coalesce((select alert_channel from public.support_settings where id = 1), 'off'),
    'items', coalesce((select jsonb_agg(to_jsonb(i) - 'unknown_since' - 'red_since' order by i.ord) from private.status_items i), '[]'::jsonb));
end $$;

create or replace function public.platform_status_mark(p_key text) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  perform private.status_guard();
  update private.status_manual set checked_on = (now() at time zone 'Asia/Jerusalem')::date, checked_by = auth.uid()
    where key = p_key;
  if not found then raise exception 'bad_key' using errcode = '22023'; end if;
  -- the row in the snapshot shows the new date at once (the hourly run recomputes it the same way)
  update private.status_items
    set level = 'manual', reading = 'נבדק ידנית: ' || to_char((now() at time zone 'Asia/Jerusalem')::date, 'FMDD.FMMM'), unknown_since = null
    where key = p_key;
end $$;

create or replace function public.platform_status_refresh() returns text
  language plpgsql security definer set search_path = '' as $$
declare v_last timestamptz;
begin
  perform private.status_guard();
  if not pg_try_advisory_xact_lock(hashtext('platform_status')) then return 'too_soon'; end if;
  select last_refresh_at into v_last from private.status_meta where id = 1 for update;
  if v_last is not null and now() - v_last < interval '120 seconds' then return 'too_soon'; end if;
  update private.status_meta set last_refresh_at = now() where id = 1;
  perform private.status_call();
  return 'started';
end $$;

revoke all on table private.status_items, private.status_manual, private.status_meta from public, anon, authenticated;
revoke all on function public.support_mail_sent_month(), public.status_figures(), public.status_snapshot_get(),
  public.status_run_begin(), public.status_run_end(),
  public.status_snapshot_put(jsonb, date), private.status_call(), private.status_guard(),
  public.platform_status(), public.platform_status_mark(text), public.platform_status_refresh() from public, anon, authenticated;
grant execute on function public.support_mail_sent_month(), public.status_figures(), public.status_snapshot_get(),
  public.status_run_begin(), public.status_run_end(),
  public.status_snapshot_put(jsonb, date) to service_role;
grant execute on function public.platform_status(), public.platform_status_mark(text), public.platform_status_refresh() to authenticated;
