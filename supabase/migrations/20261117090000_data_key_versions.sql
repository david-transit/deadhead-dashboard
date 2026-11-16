-- H1 (security review 2026-11-16): versioned data keys per operator, so a key can be rotated / revoked with one runbook
-- (pipeline/rotate_key.md). Every encrypted file carries the key id (kid) that encrypted it.
--   status current  = encrypts new files (GitHub secret DATA_KEY* = "<kid>:<base64>")
--          previous = still handed to members during a rotation, until every file is re-encrypted (finish step)
--          retired  = key material wiped; never handed out again
-- The key is generated INSIDE the database and leaves it only encrypted to a one-time local PGP public key, so it never
-- passes through a chat, a terminal or a log in clear.

alter table private.data_key drop constraint if exists data_key_pkey;
alter table private.data_key add column if not exists kid text not null default 'k0';
alter table private.data_key add column if not exists status text not null default 'current'
  check (status in ('current', 'previous', 'retired'));
alter table private.data_key add column if not exists created_at timestamptz not null default now();
alter table private.data_key add column if not exists retired_at timestamptz;
alter table private.data_key alter column key_b64 drop not null;
alter table private.data_key add primary key (operator_id, kid);
alter table private.data_key add constraint data_key_kid check (kid ~ '^k[0-9a-z]{1,20}$');
alter table private.data_key add constraint data_key_material check ((status = 'retired') = (key_b64 is null));
create unique index if not exists data_key_one_current on private.data_key (operator_id) where status = 'current';

-- members: {"current": kid, "keys": {kid: base64, ...}} with the current key and any previous one (rotation window)
drop function if exists public.get_operator_key(uuid);
create function public.get_operator_key(p_operator uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when private.has_role(p_operator, 'viewer') then (
    select jsonb_build_object(
      'current', max(k.kid) filter (where k.status = 'current'),
      'keys', coalesce(jsonb_object_agg(k.kid, k.key_b64), '{}'::jsonb))
    from private.data_key k where k.operator_id = p_operator and k.status in ('current', 'previous')) end $$;
revoke all on function public.get_operator_key(uuid) from public, anon;
grant execute on function public.get_operator_key(uuid) to authenticated;

-- rotation step 1 (SQL editor / postgres only): new random key = current, old current -> previous, older previous -> retired.
-- Returns the new key PGP-encrypted to p_pub (ASCII armour); only the holder of the one-time private key can read it.
create or replace function private.rotate_data_key(p_slug text, p_kid text, p_pub text) returns text
language plpgsql security definer set search_path = '' as $$
declare op uuid; k text;
begin
  select id into op from public.operators where slug = p_slug;
  if op is null then raise exception 'unknown operator %', p_slug; end if;
  if exists (select 1 from private.data_key where operator_id = op and kid = p_kid) then raise exception 'kid % exists', p_kid; end if;
  update private.data_key set status = 'retired', key_b64 = null, retired_at = now() where operator_id = op and status = 'previous';
  update private.data_key set status = 'previous' where operator_id = op and status = 'current';
  k := encode(extensions.gen_random_bytes(32), 'base64');
  insert into private.data_key (operator_id, kid, key_b64, status) values (op, p_kid, k, 'current');
  return extensions.armor(extensions.pgp_pub_encrypt(k, extensions.dearmor(p_pub)));
end $$;

-- rotation step 3: once every file is re-encrypted with the current key, stop handing out the previous one
create or replace function private.retire_previous_keys(p_slug text) returns int
language sql security definer set search_path = '' as $$
  with r as (update private.data_key k set status = 'retired', key_b64 = null, retired_at = now()
             from public.operators o where o.id = k.operator_id and o.slug = p_slug and k.status = 'previous' returning 1)
  select count(*)::int from r $$;

revoke all on function private.rotate_data_key(text, text, text), private.retire_previous_keys(text) from public, anon, authenticated;
