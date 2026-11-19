-- Status messages go by email to their own list (David, 19.11.2026: his private address and Nadav's), not through the
-- support tool's single alert channel. The addresses are set by David (never in this file).
alter table private.status_meta add column alert_emails text[] not null default '{}';

create or replace function public.status_snapshot_get() returns jsonb
  language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.ord) from private.status_items i), '[]'::jsonb),
    'last_digest_on', (select last_digest_on from private.status_meta where id = 1),
    'alert_emails', (select to_jsonb(alert_emails) from private.status_meta where id = 1)) $$;

-- the panel shows only whether mail goes out and to how many addresses, never the addresses
create or replace function public.platform_status() returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
declare n int := (select cardinality(alert_emails) from private.status_meta where id = 1);
begin
  perform private.status_guard();
  return jsonb_build_object(
    'checked_at', (select max(checked_at) from private.status_items),
    'alert_channel', case when n > 0 then 'email' else 'off' end,
    'alert_count', n,
    'items', coalesce((select jsonb_agg(to_jsonb(i) - 'unknown_since' - 'red_since' order by i.ord) from private.status_items i), '[]'::jsonb));
end $$;

revoke all on function public.status_snapshot_get(), public.platform_status() from public, anon, authenticated;
grant execute on function public.status_snapshot_get() to service_role;
grant execute on function public.platform_status() to authenticated;
