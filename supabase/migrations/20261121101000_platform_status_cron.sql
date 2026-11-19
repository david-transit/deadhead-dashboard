-- Hourly platform status check (spec §4). Apply only after the function platform_status is deployed and a manual
-- `select private.status_call()` wrote 15 rows. Stop: select cron.unschedule('platform_status_hourly');
select cron.schedule('platform_status_hourly', '7 * * * *', $$select private.status_call()$$);
