-- Email for yalla-sa customer support (support@yalla-sa.app). Spec: yalla-sa-support/docs/superpowers/specs/2026-11-18-email-design.md §2.
-- Extends the WhatsApp inbox tables (20261119090000_support_whatsapp.sql) instead of a parallel inbox.
-- PERSONAL DATA (addresses, names, mail text, attachments): read only by a support agent in an aal2 session, like WhatsApp.
-- Writes: Edge Functions mail_send / mail_inbound / support_jobs (service role) and the RPCs below.
-- Agreed with the WhatsApp session (18.11.2026): channel default stays 'whatsapp' (wa_webhook does not set it),
-- support_save_settings keeps everything it did, retention keeps contacts marked as spam.

-- contacts: a WhatsApp number OR an email address
alter table public.support_contacts alter column wa_id drop not null;
alter table public.support_contacts
  add column email text unique check (email = lower(email) and length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+$'),
  add column email_name text,
  add column blocked_at timestamptz,
  add constraint support_contacts_identity check (wa_id is not null or email is not null);

alter table public.support_conversations
  add column channel text not null default 'whatsapp' check (channel in ('whatsapp', 'email')),
  add column subject text,
  add column reminded_at timestamptz;
create index on public.support_conversations (channel, status);

alter table public.support_messages
  add column channel text not null default 'whatsapp' check (channel in ('whatsapp', 'email')),
  add column email_message_id text unique,
  add column email_refs text[],
  add column attachments jsonb;
create index on public.support_messages using gin (email_refs);

alter table public.support_settings
  add column alert_email text check (alert_email is null or alert_email ~ '^[^@\s]+@[^@\s]+$'),
  add column mail_daily_cap int not null default 100 check (mail_daily_cap > 10);

-- settings: the WhatsApp version (20261119090000) unchanged, plus alert_email and mail_daily_cap
create or replace function public.support_save_settings(p jsonb) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_platform_admin() and private.is_aal2()) then raise exception 'not_allowed' using errcode = '42501'; end if;
  update public.support_settings set
    monthly_cap_ils = coalesce((p->>'monthly_cap_ils')::numeric, monthly_cap_ils),
    usd_ils = coalesce((p->>'usd_ils')::numeric, usd_ils),
    rates = coalesce(p->'rates', rates),
    ai_daily_per_contact = coalesce((p->>'ai_daily_per_contact')::int, ai_daily_per_contact),
    menu_daily_per_contact = coalesce((p->>'menu_daily_per_contact')::int, menu_daily_per_contact),
    alert_channel = coalesce(p->>'alert_channel', alert_channel),
    alert_to = case when p ? 'alert_to' then nullif(p->>'alert_to', '') else alert_to end,
    hours = coalesce(p->'hours', hours),
    alert_email = case when p ? 'alert_email' then lower(nullif(trim(p->>'alert_email'), '')) else alert_email end,
    mail_daily_cap = coalesce((p->>'mail_daily_cap')::int, mail_daily_cap)
  where id = 1;
  -- the alert number must be able to receive templates: record its consent (it is the admin's own choice)
  if nullif(p->>'alert_to', '') is not null then
    insert into public.support_contacts (wa_id, consent_at, consent_by) values (p->>'alert_to', now(), (select auth.uid()))
    on conflict (wa_id) do update set consent_at = coalesce(public.support_contacts.consent_at, now()),
      consent_by = coalesce(public.support_contacts.consent_by, (select auth.uid()));
  end if;
end $$;

-- agent: mark a conversation's sender as spam (M7): closes it; later mail from that address opens nothing
create or replace function public.support_mark_spam(p_conv uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare c uuid;
begin
  if not (private.is_support_agent() and private.is_aal2()) then raise exception 'not_allowed' using errcode = '42501'; end if;
  update public.support_conversations set status = 'closed', closed_at = now(), bot_state = null
  where id = p_conv returning contact_id into c;
  if c is null then raise exception 'not_found'; end if;
  update public.support_contacts set blocked_at = coalesce(blocked_at, now()) where id = c;
end $$;
revoke all on function public.support_mark_spam(uuid) from public, anon;
grant execute on function public.support_mark_spam(uuid) to authenticated;

-- mails sent today (Israel calendar day), for the daily quota (M10)
create or replace function public.support_mail_sent_today() returns int
  language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.support_messages
  where channel = 'email' and direction = 'out' and status = 'sent'
    and created_at >= (date_trunc('day', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem') $$;
revoke all on function public.support_mail_sent_today() from public, anon, authenticated;
grant execute on function public.support_mail_sent_today() to service_role;

-- retention: as in 20261119090000, but a contact marked as spam is kept (its block must not be forgotten)
create or replace function private.support_retention() returns void
  language sql security definer set search_path = '' as $$
  delete from public.support_conversations where status = 'closed' and closed_at < now() - interval '12 months';
  delete from public.support_messages where conversation_id is null and created_at < now() - interval '12 months';
  delete from public.support_spend where created_at < now() - interval '24 months';
  delete from public.support_contacts c where c.opted_out_at is null and c.consent_at is null and c.user_id is null
    and c.blocked_at is null
    and not exists (select 1 from public.support_conversations v where v.contact_id = c.id)
    and not exists (select 1 from public.support_messages m where m.contact_id = c.id);
$$;
revoke all on function private.support_retention() from public, anon, authenticated;

-- attachments (M6): private bucket, 10MB per file; read by agents in aal2 only; written by the service role
insert into storage.buckets (id, name, public, file_size_limit)
values ('support-attachments', 'support-attachments', false, 10485760)
on conflict (id) do nothing;
create policy support_attach_read on storage.objects for select to authenticated
  using (bucket_id = 'support-attachments' and private.is_support_agent() and private.is_aal2());

-- the email signature logo (public)
insert into storage.buckets (id, name, public) values ('brand', 'brand', true) on conflict (id) do nothing;
