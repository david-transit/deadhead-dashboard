-- Retention (privacy docs: yalla-sa-portal/docs/privacy/04-retention.md): the auth/admin event log keeps 24 months
-- (regulation 17 of the Privacy Protection (Data Security) Regulations 2017), then rows are deleted. No scheduler on
-- the free plan: every new event first removes the expired ones (cheap: index on "at").
create index if not exists auth_events_at_idx on private.auth_events (at);

create or replace function public.auth_event(p_user uuid, p_username text, p_event text, p_detail jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.auth_events where at < now() - interval '24 months';
  insert into private.auth_events (user_id, username, event, detail) values (p_user, p_username, p_event, p_detail);
end $$;
revoke all on function public.auth_event(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.auth_event(uuid, text, text, jsonb) to service_role;
