-- Follow-up to 20261119090000_support_whatsapp.sql: this project revokes default table privileges from authenticated
-- (20261116150707_tighten_grants.sql), so every table is opened explicitly. SELECT only; RLS (agent + aal2) decides
-- which rows; all writes go through the Edge Functions (service role) or the security-definer RPCs.
grant select on public.support_contacts, public.support_conversations, public.support_messages, public.support_spend,
  public.support_settings, public.support_agents, public.support_answers to authenticated;
