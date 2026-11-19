-- WhatsApp customer support (yalla-sa). Spec: yalla-sa-support/docs/superpowers/specs/2026-11-18-whatsapp-design.md §2–§3.
-- PERSONAL DATA (phone numbers, names, message text): per the rule in 20261118120000_mfa_step_up.sql, reading it needs aal2.
-- Writes come from the Edge Functions wa_send / wa_webhook / manage_users (service role) or the RPCs below; no direct
-- insert/update/delete for signed-in users. Region: eu-central-1.
-- Phone + consent of a portal user live in support_contacts (user_id, consent_at, consent_by), NOT in profiles,
-- so whoever can read profiles never sees phone numbers.

create extension if not exists pg_cron;

create table public.support_contacts (
  id uuid primary key default gen_random_uuid(),
  wa_id text not null unique check (wa_id ~ '^[0-9]{10,15}$'),
  wa_name text,
  user_id uuid references auth.users(id) on delete set null,
  consent_at timestamptz,
  consent_by uuid references auth.users(id) on delete set null,
  opted_out_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.support_contacts (user_id);

create table public.support_conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.support_contacts(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'assigned', 'closed')),
  assignee uuid references auth.users(id) on delete set null,
  bot_state jsonb,
  last_inbound_at timestamptz,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index on public.support_conversations (contact_id, created_at desc);
create index on public.support_conversations (status, closed_at);

create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.support_conversations(id) on delete cascade,
  contact_id uuid not null references public.support_contacts(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  sender text not null check (sender in ('contact', 'bot', 'agent', 'system')),
  agent_id uuid references auth.users(id) on delete set null,
  body text,
  template text,
  wa_message_id text unique,
  status text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'read', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create index on public.support_messages (conversation_id, created_at);
create index on public.support_messages (contact_id, sender, created_at);

create table public.support_spend (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('meta', 'ai')),
  category text not null,
  amount_ils numeric(12, 6) not null check (amount_ils >= 0),
  wa_message_id text unique,
  created_at timestamptz not null default now()
);
create index on public.support_spend (created_at);

create table public.support_settings (
  id int primary key default 1 check (id = 1),
  monthly_cap_ils numeric not null default 20 check (monthly_cap_ils >= 0),
  usd_ils numeric not null default 3.7 check (usd_ils > 0),
  rates jsonb not null default '{"utility":0.0053,"authentication":0.0053,"marketing":0.0353,"service":0}',
  ai_daily_per_contact int not null default 20,
  menu_daily_per_contact int not null default 50,
  alert_channel text not null default 'whatsapp' check (alert_channel in ('whatsapp', 'email', 'off')),
  alert_to text check (alert_to ~ '^[0-9]{10,15}$'),
  hours jsonb not null default '{"days":[0,1,2,3,4],"from":"08:00","to":"17:00"}',
  alerts_sent jsonb not null default '{"month":"","levels":[]}'
);
insert into public.support_settings (id) values (1);

create table public.support_agents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

create table public.support_answers (
  key text primary key,
  body text not null
);
insert into public.support_answers (key, body) values
  ('1', 'בעיה בכניסה? אפשר לאפס סיסמה במסך הכניסה של yalla-sa.app, או לבקש מהמנהל אצל המפעיל סיסמה זמנית חדשה.'),
  ('2', 'מדריך לכלי הנסיעות הריקות נמצא בכלי עצמו, תחת "עזרה". אם לא מצאת תשובה, כתוב 3 ונציג יחזור אליך.'),
  ('hours_off', 'קיבלנו. נחזור אליך ביום העבודה הבא');

-- who may read support data: a support agent, in an aal2 session
create or replace function private.is_support_agent() returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.is_active() and exists (select 1 from public.support_agents where user_id = (select auth.uid())) $$;
revoke all on function private.is_support_agent() from public, anon;
grant execute on function private.is_support_agent() to authenticated;

alter table public.support_contacts enable row level security;
alter table public.support_conversations enable row level security;
alter table public.support_messages enable row level security;
alter table public.support_spend enable row level security;
alter table public.support_settings enable row level security;
alter table public.support_agents enable row level security;
alter table public.support_answers enable row level security;

create policy support_read on public.support_contacts for select to authenticated using (private.is_support_agent() and private.is_aal2());
create policy support_read on public.support_conversations for select to authenticated using (private.is_support_agent() and private.is_aal2());
create policy support_read on public.support_messages for select to authenticated using (private.is_support_agent() and private.is_aal2());
create policy support_read on public.support_spend for select to authenticated using (private.is_support_agent() and private.is_aal2());
create policy support_read on public.support_settings for select to authenticated using (private.is_support_agent() and private.is_aal2());
create policy support_read on public.support_answers for select to authenticated using (private.is_support_agent() and private.is_aal2());
create policy support_read on public.support_agents for select to authenticated
  using (user_id = (select auth.uid()) or (private.is_platform_admin() and private.is_aal2()));

-- the portal shows the tile to agents (no aal2 needed: it reveals nothing but "you are an agent")
create or replace function public.support_is_agent() returns boolean
  language sql stable security definer set search_path = '' as $$ select private.is_support_agent() $$;
revoke all on function public.support_is_agent() from public, anon;
grant execute on function public.support_is_agent() to authenticated;

-- this month's spend in ILS (Israel calendar month)
create or replace function public.support_month_spend() returns numeric
  language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount_ils), 0) from public.support_spend
  where created_at >= (date_trunc('month', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem') $$;
revoke all on function public.support_month_spend() from public, anon, authenticated;
grant execute on function public.support_month_spend() to service_role;

-- budget alert once per level per month: true only the first time
create or replace function public.support_mark_alert(p_level text) returns boolean
  language plpgsql security definer set search_path = '' as $$
declare m text := to_char(now() at time zone 'Asia/Jerusalem', 'YYYY-MM'); s jsonb;
begin
  if p_level not in ('warn80', 'over') then raise exception 'bad level'; end if;
  select alerts_sent into s from public.support_settings where id = 1 for update;
  if s->>'month' is distinct from m then s := jsonb_build_object('month', m, 'levels', '[]'::jsonb); end if;
  if (s->'levels') ? p_level then return false; end if;
  update public.support_settings set alerts_sent = jsonb_set(s, '{levels}', (s->'levels') || to_jsonb(p_level)) where id = 1;
  return true;
end $$;
revoke all on function public.support_mark_alert(text) from public, anon, authenticated;
grant execute on function public.support_mark_alert(text) to service_role;

-- agent: change status / assignee of a conversation
create or replace function public.support_set_status(p_conv uuid, p_status text, p_assignee uuid) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_support_agent() and private.is_aal2()) then raise exception 'not_allowed' using errcode = '42501'; end if;
  if p_status not in ('open', 'assigned', 'closed') then raise exception 'bad_input'; end if;
  if p_assignee is not null and not exists (select 1 from public.support_agents where user_id = p_assignee) then
    raise exception 'bad_input';
  end if;
  update public.support_conversations set status = p_status, assignee = p_assignee,
    closed_at = case when p_status = 'closed' then now() end,
    bot_state = case when p_status = 'closed' then null else bot_state end
  where id = p_conv;
  if not found then raise exception 'not_found'; end if;
end $$;
revoke all on function public.support_set_status(uuid, text, uuid) from public, anon;
grant execute on function public.support_set_status(uuid, text, uuid) to authenticated;

-- platform admin (aal2): settings, ready answers, agents
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
    hours = coalesce(p->'hours', hours)
  where id = 1;
  -- the alert number must be able to receive templates: record its consent (it is the admin's own choice)
  if nullif(p->>'alert_to', '') is not null then
    insert into public.support_contacts (wa_id, consent_at, consent_by) values (p->>'alert_to', now(), (select auth.uid()))
    on conflict (wa_id) do update set consent_at = coalesce(public.support_contacts.consent_at, now()),
      consent_by = coalesce(public.support_contacts.consent_by, (select auth.uid()));
  end if;
end $$;
create or replace function public.support_save_answer(p_key text, p_body text) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_platform_admin() and private.is_aal2()) then raise exception 'not_allowed' using errcode = '42501'; end if;
  if p_key not in ('1', '2', 'hours_off') or length(coalesce(p_body, '')) not between 1 and 1000 then raise exception 'bad_input'; end if;
  insert into public.support_answers (key, body) values (p_key, p_body) on conflict (key) do update set body = excluded.body;
end $$;
create or replace function public.support_add_agent(p_user uuid) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_platform_admin() and private.is_aal2()) then raise exception 'not_allowed' using errcode = '42501'; end if;
  insert into public.support_agents (user_id) values (p_user) on conflict do nothing;
end $$;
create or replace function public.support_remove_agent(p_user uuid) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_platform_admin() and private.is_aal2()) then raise exception 'not_allowed' using errcode = '42501'; end if;
  delete from public.support_agents where user_id = p_user;
end $$;
revoke all on function public.support_save_settings(jsonb) from public, anon;
revoke all on function public.support_save_answer(text, text) from public, anon;
revoke all on function public.support_add_agent(uuid) from public, anon;
revoke all on function public.support_remove_agent(uuid) from public, anon;
grant execute on function public.support_save_settings(jsonb) to authenticated;
grant execute on function public.support_save_answer(text, text) to authenticated;
grant execute on function public.support_add_agent(uuid) to authenticated;
grant execute on function public.support_remove_agent(uuid) to authenticated;

-- retention (R15, David 18.11.2026): closed conversations 12 months; messages outside a conversation 12 months;
-- spend 24 months; contacts with nothing left and no opt-out / consent / portal user
create or replace function private.support_retention() returns void
  language sql security definer set search_path = '' as $$
  delete from public.support_conversations where status = 'closed' and closed_at < now() - interval '12 months';
  delete from public.support_messages where conversation_id is null and created_at < now() - interval '12 months';
  delete from public.support_spend where created_at < now() - interval '24 months';
  delete from public.support_contacts c where c.opted_out_at is null and c.consent_at is null and c.user_id is null
    and not exists (select 1 from public.support_conversations v where v.contact_id = c.id)
    and not exists (select 1 from public.support_messages m where m.contact_id = c.id);
$$;
revoke all on function private.support_retention() from public, anon, authenticated;
select cron.schedule('support_retention', '30 2 * * *', 'select private.support_retention()');
