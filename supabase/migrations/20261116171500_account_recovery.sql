-- Account recovery for platform admins (no SMTP of our own):
--  * one-time recovery codes (only SHA-256 hashes stored; each code burns on use)
--  * optional recovery email (the Supabase Auth email of that admin becomes the real address, so the built-in
--    mailer can send "reset password"; sign-in by username keeps working through manage_users)
--  * attempt log (rate limit per username) and an auth event log
-- Private tables, reached only through these functions, executable only by service_role (manage_users).
-- No existing row is changed.

create table private.recovery_codes (
  user_id uuid not null references auth.users (id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  primary key (user_id, code_hash)
);
create table private.recovery_email (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  updated_at timestamptz not null default now()
);
create table private.auth_attempts (
  username text not null,
  kind text not null,
  at timestamptz not null default now()
);
create index on private.auth_attempts (username, kind, at);
create table private.auth_events (
  at timestamptz not null default now(),
  user_id uuid,
  username text,
  event text not null,
  detail jsonb
);
alter table private.recovery_codes enable row level security;
alter table private.recovery_email enable row level security;
alter table private.auth_attempts enable row level security;
alter table private.auth_events enable row level security;
revoke all on private.recovery_codes, private.recovery_email, private.auth_attempts, private.auth_events from public, anon, authenticated;

-- one attempt of kind k for username u; true = allowed (max 5 per 15 min and 20 per day per username + kind)
create or replace function public.auth_attempt(p_username text, p_kind text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n15 int; n24 int;
begin
  delete from private.auth_attempts where at < now() - interval '2 days';
  select count(*) filter (where at > now() - interval '15 minutes'), count(*) into n15, n24
    from private.auth_attempts where username = lower(p_username) and kind = p_kind and at > now() - interval '1 day';
  if n15 >= 5 or n24 >= 20 then return false; end if;
  insert into private.auth_attempts (username, kind) values (lower(p_username), p_kind);
  return true;
end $$;

create or replace function public.auth_event(p_user uuid, p_username text, p_event text, p_detail jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into private.auth_events (user_id, username, event, detail) values (p_user, p_username, p_event, p_detail) $$;

create or replace function public.recovery_set_codes(p_user uuid, p_hashes text[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.recovery_codes where user_id = p_user;
  insert into private.recovery_codes (user_id, code_hash) select p_user, h from unnest(p_hashes) h;
end $$;

create or replace function public.recovery_use_code(p_user uuid, p_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update private.recovery_codes set used_at = now() where user_id = p_user and code_hash = p_hash and used_at is null;
  return found;
end $$;

create or replace function public.recovery_codes_left(p_user uuid) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from private.recovery_codes where user_id = p_user and used_at is null $$;

create or replace function public.recovery_email_get(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select email from private.recovery_email where user_id = p_user $$;

create or replace function public.recovery_email_set(p_user uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_email is null then
    delete from private.recovery_email where user_id = p_user;
  else
    insert into private.recovery_email (user_id, email) values (p_user, lower(p_email))
      on conflict (user_id) do update set email = excluded.email, updated_at = now();
  end if;
end $$;

revoke all on function public.auth_attempt(text, text), public.auth_event(uuid, text, text, jsonb),
  public.recovery_set_codes(uuid, text[]), public.recovery_use_code(uuid, text), public.recovery_codes_left(uuid),
  public.recovery_email_get(uuid), public.recovery_email_set(uuid, text) from public, anon, authenticated;
grant execute on function public.auth_attempt(text, text), public.auth_event(uuid, text, text, jsonb),
  public.recovery_set_codes(uuid, text[]), public.recovery_use_code(uuid, text), public.recovery_codes_left(uuid),
  public.recovery_email_get(uuid), public.recovery_email_set(uuid, text) to service_role;
