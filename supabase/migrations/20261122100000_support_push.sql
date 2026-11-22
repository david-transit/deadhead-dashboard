-- Push alerts from the site (PRD-email M20; design yalla-sa-support/docs/superpowers/specs/2026-11-22-email-push-alerts-design.md §2).
-- One row per agent device. Written only by the Edge Function support_push (service role); an agent reads and deletes own rows.
-- Removing an agent removes their devices (cascade). Nothing but the push address and its keys is stored.
create table public.support_push_subs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.support_agents(user_id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://'),
  p256dh text not null,
  auth text not null,
  label text check (label is null or length(label) <= 40),
  created_at timestamptz not null default now()
);
create index support_push_subs_user on public.support_push_subs (user_id);

alter table public.support_push_subs enable row level security;
create policy push_own_read on public.support_push_subs for select to authenticated using (user_id = (select auth.uid()));
create policy push_own_delete on public.support_push_subs for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.support_push_subs from anon;
grant select, delete on public.support_push_subs to authenticated;
revoke insert, update, truncate, references, trigger on public.support_push_subs from authenticated;

-- new alert channel 'push'; it becomes the channel (none was configured: no alert_to, no alert_email; David, 22.11.2026)
alter table public.support_settings drop constraint support_settings_alert_channel_check;
alter table public.support_settings add constraint support_settings_alert_channel_check
  check (alert_channel in ('whatsapp', 'email', 'push', 'off'));
alter table public.support_settings alter column alert_channel set default 'push';
update public.support_settings set alert_channel = 'push' where id = 1;
