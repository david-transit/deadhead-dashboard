-- Welcome mail / "send details" (spec: yalla-sa-support/docs/superpowers/specs/2026-11-19-welcome-mail-design.md §5).
-- A contact email per user (platform admins only, through manage_users), a 7-day expiry for temporary passwords,
-- a log of account mails (no body, no password, no address) that counts toward the daily Resend cap, a per-user
-- send lock, and snapshot/restore of the password hash so a failed send leaves the old password in place.
-- Browser roles reach none of it: no policies, no grants; every function is service_role only.

create table private.user_contact_email (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null check (email = lower(email) and length(email) <= 254),
  set_by uuid references auth.users(id) on delete set null,
  set_at timestamptz not null default now()
);
alter table private.user_contact_email enable row level security;

alter table public.profiles add column if not exists temp_password_expires_at timestamptz;

create table private.account_mail_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  sent_by uuid references auth.users(id) on delete set null,
  status text not null check (status in ('sent', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
alter table private.account_mail_log enable row level security;
create index account_mail_log_created on private.account_mail_log (created_at);

create table private.details_lock (
  user_id uuid primary key references auth.users(id) on delete cascade,
  until timestamptz not null
);
alter table private.details_lock enable row level security;

revoke all on private.user_contact_email, private.account_mail_log, private.details_lock from public, anon, authenticated;

create or replace function public.contact_email_get(p_user uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select email from private.user_contact_email where user_id = p_user $$;

create or replace function public.contact_email_set(p_user uuid, p_email text, p_by uuid) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if p_email is null then
    delete from private.user_contact_email where user_id = p_user;
  else
    insert into private.user_contact_email (user_id, email, set_by) values (p_user, p_email, p_by)
    on conflict (user_id) do update set email = excluded.email, set_by = excluded.set_by, set_at = now();
  end if;
end $$;

create or replace function public.contact_email_users() returns setof uuid
  language sql stable security definer set search_path = '' as $$
  select user_id from private.user_contact_email $$;

create or replace function public.pw_snapshot(p_user uuid) returns table (hash text, must boolean, exp timestamptz)
  language sql stable security definer set search_path = '' as $$
  select u.encrypted_password::text, p.must_change_password, p.temp_password_expires_at
  from auth.users u join public.profiles p on p.user_id = u.id where u.id = p_user $$;

-- puts back what pw_snapshot returned; the auth.users guard needs its one-shot permit for a changed hash
create or replace function public.pw_restore(p_user uuid, p_hash text, p_must boolean, p_exp timestamptz) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  insert into private.pw_change_allow (user_id) values (p_user) on conflict (user_id) do update set at = now();
  update auth.users set encrypted_password = p_hash where id = p_user;
  delete from private.pw_change_allow where user_id = p_user; -- unused when the hash did not change
  update public.profiles set must_change_password = p_must, temp_password_expires_at = p_exp where user_id = p_user;
end $$;

create or replace function public.details_lock(p_user uuid) returns boolean
  language plpgsql security definer set search_path = '' as $$
declare got int;
begin
  insert into private.details_lock (user_id, until) values (p_user, now() + interval '60 seconds')
  on conflict (user_id) do update set until = excluded.until where private.details_lock.until < now();
  get diagnostics got = row_count;
  return got = 1;
end $$;

create or replace function public.details_unlock(p_user uuid) returns void
  language sql security definer set search_path = '' as $$
  delete from private.details_lock where user_id = p_user $$;

create or replace function public.account_mail_log_add(p_user uuid, p_by uuid, p_status text, p_error text) returns void
  language sql security definer set search_path = '' as $$
  insert into private.account_mail_log (user_id, sent_by, status, error) values (p_user, p_by, p_status, left(p_error, 300)) $$;

-- the daily Resend cap counts support mail AND account mail (one Resend account, one 100/day limit)
create or replace function public.support_mail_sent_today() returns int
  language sql stable security definer set search_path = '' as $$
  with d as (select (date_trunc('day', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem') as t0)
  select ((select count(*) from public.support_messages, d
           where channel = 'email' and direction = 'out' and status = 'sent' and created_at >= d.t0)
        + (select count(*) from private.account_mail_log, d where status = 'sent' and created_at >= d.t0))::int $$;

-- retention: as in 20261120090000, plus the account mail log after 12 months
create or replace function private.support_retention() returns void
  language sql security definer set search_path = '' as $$
  delete from public.support_conversations where status = 'closed' and closed_at < now() - interval '12 months';
  delete from public.support_messages where conversation_id is null and created_at < now() - interval '12 months';
  delete from public.support_spend where created_at < now() - interval '24 months';
  delete from public.support_contacts c where c.opted_out_at is null and c.consent_at is null and c.user_id is null
    and c.blocked_at is null
    and not exists (select 1 from public.support_conversations v where v.contact_id = c.id)
    and not exists (select 1 from public.support_messages m where m.contact_id = c.id);
  delete from private.account_mail_log where created_at < now() - interval '12 months';
$$;

do $$
declare f text;
begin
  foreach f in array array['public.contact_email_get(uuid)', 'public.contact_email_set(uuid,text,uuid)', 'public.contact_email_users()',
    'public.pw_snapshot(uuid)', 'public.pw_restore(uuid,text,boolean,timestamptz)', 'public.details_lock(uuid)',
    'public.details_unlock(uuid)', 'public.account_mail_log_add(uuid,uuid,text,text)', 'public.support_mail_sent_today()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke all on function private.support_retention() from public, anon, authenticated;
