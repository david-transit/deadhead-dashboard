-- Status alert addresses are edited in the panel (David, 19.11.2026: "שיהיה אפשרות בפאנל הסופי לעדכן גם את זה").
-- Platform admins in an aal2 session see the list and replace it; the server checks every address.
-- An empty list turns status alerts off.

create or replace function public.platform_status() returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
declare e text[] := (select alert_emails from private.status_meta where id = 1);
begin
  perform private.status_guard();
  return jsonb_build_object(
    'checked_at', (select max(checked_at) from private.status_items),
    'alert_channel', case when cardinality(e) > 0 then 'email' else 'off' end,
    'alert_count', cardinality(e),
    'alert_emails', to_jsonb(e),
    'items', coalesce((select jsonb_agg(to_jsonb(i) - 'unknown_since' - 'red_since' order by i.ord) from private.status_items i), '[]'::jsonb));
end $$;

-- replaces the whole list: trimmed, lower case, no repeats, at most 10; one bad address rejects the save (nothing changes)
create or replace function public.platform_status_set_emails(p_emails text[]) returns text[]
  language plpgsql security definer set search_path = '' as $$
declare v text[]; bad text;
begin
  perform private.status_guard();
  select coalesce(array_agg(x order by o), '{}') into v from (
    select x, min(o) o from (
      select lower(btrim(a)) x, o from unnest(coalesce(p_emails, '{}')) with ordinality as t(a, o)) s
    where x <> '' group by x) d;
  select x into bad from unnest(v) x where x !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(x) > 254 limit 1;
  if bad is not null then raise exception 'bad_email' using errcode = '22023', detail = bad; end if;
  if cardinality(v) > 10 then raise exception 'too_many' using errcode = '22023'; end if;
  update private.status_meta set alert_emails = v where id = 1;
  return v;
end $$;

revoke all on function public.platform_status(), public.platform_status_set_emails(text[]) from public, anon, authenticated;
grant execute on function public.platform_status(), public.platform_status_set_emails(text[]) to authenticated;
