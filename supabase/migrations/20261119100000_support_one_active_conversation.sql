-- Review I7: one not-closed conversation per contact, so two webhooks arriving together cannot open two conversations
-- (db.ts activeConversation re-selects on 23505). Safe on an empty table; NOT applied until David approves.
create unique index support_conversations_one_active on public.support_conversations (contact_id) where status <> 'closed';
