-- Schedules for support_jobs (yalla-sa support). Spec: yalla-sa-support/docs/superpowers/specs/2026-11-18-email-design.md §3.
-- Needs, BEFORE this migration: the Edge Function support_jobs deployed (verify_jwt off), and a Vault secret
-- 'support_internal_key' = the same value as the function secret WA_INTERNAL_KEY (David creates it; never in this file).
create extension if not exists pg_net;

create or replace function private.support_jobs_call(p_job text) returns void
  language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'support_internal_key';
  if k is null then raise warning 'support_jobs: vault secret support_internal_key missing'; return; end if;
  perform net.http_post(
    url := 'https://xghfcdgettrcdciwwzbl.supabase.co/functions/v1/support_jobs',
    body := jsonb_build_object('job', p_job),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-key', k),
    timeout_milliseconds := 30000);
end $$;
revoke all on function private.support_jobs_call(text) from public, anon, authenticated;

select cron.schedule('support_reminders', '*/15 * * * *', $$select private.support_jobs_call('reminders')$$);
select cron.schedule('support_queued_mail', '5 * * * *', $$select private.support_jobs_call('queued')$$);
select cron.schedule('support_files_cleanup', '0 3 * * *', $$select private.support_jobs_call('files')$$);
