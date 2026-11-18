// SupportDb on Supabase (service role; RLS is bypassed here, so every caller is checked in the function first).
// Tables: migration <ts>_support_whatsapp.sql (spec §2).
// deno-lint-ignore-file no-explicit-any
import type { SupportSettings, Contact, NewMessage } from "./send.ts";
import type { InboundDb, Conversation } from "./inbound.ts";

const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };
// midnight in Israel for the day of `now`, as a UTC instant (for "today" counters)
function israelDayStart(now: Date): Date {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hourCycle: "h23",
    hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  return new Date(now.getTime() - ((+p.hour * 60 + +p.minute) * 60 + +p.second) * 1000 - now.getMilliseconds());
}
const dup = (e: any) => e?.code === "23505";

export function supabaseDb(admin: any): InboundDb & {
  contactId(waId: string, name?: string): Promise<string>;
} {
  async function contactId(waId: string, name?: string): Promise<string> {
    const { data } = await admin.from("support_contacts").select("id").eq("wa_id", waId).maybeSingle();
    if (data) return data.id;
    const { data: ins, error } = await admin.from("support_contacts")
      .upsert({ wa_id: waId, wa_name: name ?? null }, { onConflict: "wa_id" }).select("id").single();
    if (error) throw error;
    return ins.id;
  }
  return {
    contactId,
    async settings(): Promise<SupportSettings> {
      const { data, error } = await admin.from("support_settings").select("*").eq("id", 1).single();
      if (error) throw error;
      return data as SupportSettings;
    },
    async contactByPhone(waId: string): Promise<Contact | null> {
      // portal users' phone + consent are kept here too (support_contacts.user_id), written by manage_users
      const { data: c } = await admin.from("support_contacts").select("id, consent_at, opted_out_at").eq("wa_id", waId).maybeSingle();
      if (!c) return null;
      return { id: c.id, consent: !!c.consent_at, optedOut: !!c.opted_out_at };
    },
    async lastInboundAt(waId: string): Promise<Date | null> {
      const { data } = await admin.from("support_conversations").select("last_inbound_at, support_contacts!inner(wa_id)")
        .eq("support_contacts.wa_id", waId).not("last_inbound_at", "is", null)
        .order("last_inbound_at", { ascending: false }).limit(1);
      return data?.[0]?.last_inbound_at ? new Date(data[0].last_inbound_at) : null;
    },
    async monthSpend(): Promise<number> {
      const { data, error } = await admin.rpc("support_month_spend");
      if (error) throw error;
      return Number(data ?? 0);
    },
    async insertMessage(m: NewMessage): Promise<string> {
      const contact_id = await contactId(m.to);
      const { data, error } = await admin.from("support_messages").insert({
        contact_id, conversation_id: m.conversation_id, direction: "out", sender: m.sender, agent_id: m.agent_id,
        body: m.body, template: m.template, status: m.status,
      }).select("id").single();
      if (error) throw error;
      return data.id;
    },
    async updateMessage(id, patch) {
      const { error } = await admin.from("support_messages").update(patch).eq("id", id);
      if (error) throw error;
    },
    async markAlertSent(level) {
      const { data, error } = await admin.rpc("support_mark_alert", { p_level: level });
      if (error) throw error;
      return !!data;
    },
    async answers() {
      const { data } = await admin.from("support_answers").select("key, body");
      return Object.fromEntries((data ?? []).map((r: any) => [r.key, r.body]));
    },
    async upsertContact(waId, name) {
      const { data, error } = await admin.from("support_contacts")
        .upsert({ wa_id: waId, wa_name: name || null }, { onConflict: "wa_id" }).select("id").single();
      if (error) throw error;
      return data.id;
    },
    async activeConversation(contactId): Promise<Conversation> {
      const { data } = await admin.from("support_conversations").select("id, status, assignee, bot_state")
        .eq("contact_id", contactId).neq("status", "closed").order("created_at", { ascending: false }).limit(1);
      if (data?.length) return data[0];
      const { data: ins, error } = await admin.from("support_conversations").insert({ contact_id: contactId, status: "open" })
        .select("id, status, assignee, bot_state").single();
      if (dup(error)) { // two webhooks at once: the unique index let only one insert win; use that one (review I7)
        const { data: again } = await admin.from("support_conversations").select("id, status, assignee, bot_state")
          .eq("contact_id", contactId).neq("status", "closed").limit(1);
        if (again?.length) return again[0];
      }
      if (error) throw error;
      return ins;
    },
    async recordInbound(convId, contactId, _waId, wamid, text, ts) {
      const { error } = await admin.from("support_messages").insert({ conversation_id: convId, contact_id: contactId,
        direction: "in", sender: "contact", body: text.slice(0, 4096), wa_message_id: wamid, status: "read", created_at: ts.toISOString() });
      if (dup(error)) return false;
      if (error) throw error;
      await admin.from("support_conversations").update({ last_inbound_at: ts.toISOString() }).eq("id", convId);
      return true;
    },
    async saveConversation(convId, patch) {
      const { error } = await admin.from("support_conversations").update(patch).eq("id", convId);
      if (error) throw error;
    },
    async setOptOut(waId) {
      const { error } = await admin.from("support_contacts").update({ opted_out_at: new Date().toISOString() }).eq("wa_id", waId);
      if (error) throw error;
    },
    async botRepliesToday(contactId, now) {
      const { count } = await admin.from("support_messages").select("id", { count: "exact", head: true })
        .eq("contact_id", contactId).eq("sender", "bot").gte("created_at", israelDayStart(now).toISOString());
      return count ?? 0;
    },
    async addSpend(wamid, category, amountIls) {
      const { error } = await admin.from("support_spend").insert({ kind: "meta", category, amount_ils: amountIls, wa_message_id: wamid });
      if (dup(error)) return false;
      if (error) throw error;
      return true;
    },
    async setStatus(wamid, status, error) {
      // statuses can arrive out of order: never step back (read -> sent); failed always applies
      let q = admin.from("support_messages").update(error ? { status, error } : { status }).eq("wa_message_id", wamid);
      if (status !== "failed") q = q.in("status", Object.keys(RANK).filter((k) => RANK[k] < (RANK[status] ?? 0)));
      await q;
    },
  };
}
