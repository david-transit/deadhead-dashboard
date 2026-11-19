// InboundMailDb on Supabase (service role). Email spec §2–§3.
// deno-lint-ignore-file no-explicit-any
import type { InboundMailDb } from "./inbound.ts";
import { one, emailContactOn } from "./db.ts";

// midnight in Israel for the day of `now`, as a UTC instant
export function israelDayStart(now: Date): Date {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hourCycle: "h23",
    hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  return new Date(now.getTime() - ((+p.hour * 60 + +p.minute) * 60 + +p.second) * 1000 - now.getMilliseconds());
}
const BODY_MAX = 50_000;

export function supabaseInboundDb(admin: any, bucket = "support-attachments"): InboundMailDb {
  return {
    async seen(mid) {
      const r = await one(admin.from("support_messages").select("id").eq("email_message_id", mid).limit(1));
      return r.length > 0;
    },
    emailContact: (email, name) => emailContactOn(admin, email, name),
    async isBlocked(contactId) {
      const r = await one(admin.from("support_contacts").select("blocked_at").eq("id", contactId).single());
      return !!r.blocked_at;
    },
    async inboundToday(contactId, now) {
      const { count, error } = await admin.from("support_messages").select("id", { count: "exact", head: true })
        .eq("contact_id", contactId).eq("channel", "email").eq("direction", "in").gte("created_at", israelDayStart(now).toISOString());
      if (error) throw error;
      return count ?? 0;
    },
    async convByRefs(refs) {
      const r = await one(admin.from("support_messages").select("conversation_id, support_conversations!inner(id, status)")
        .in("email_message_id", refs).not("conversation_id", "is", null).limit(1));
      return r[0] ? { id: r[0].support_conversations.id, status: r[0].support_conversations.status } : null;
    },
    async openEmailConv(contactId) {
      const r = await one(admin.from("support_conversations").select("id, status").eq("contact_id", contactId)
        .eq("channel", "email").neq("status", "closed").order("created_at", { ascending: false }).limit(1));
      return r[0] ?? null;
    },
    async newEmailConv(contactId, subject) {
      const { data, error } = await admin.from("support_conversations").insert({ contact_id: contactId, channel: "email",
        subject: subject?.slice(0, 300) ?? null, status: "open" }).select("id").single();
      if (error?.code === "23505") { // a parallel delivery opened it first (one active conversation per contact)
        const r = await one(admin.from("support_conversations").select("id").eq("contact_id", contactId).neq("status", "closed").limit(1));
        if (r[0]) return r[0].id;
      }
      if (error) throw error;
      return data.id;
    },
    async reopen(convId) {
      await one(admin.from("support_conversations").update({ status: "open", closed_at: null, reminded_at: null }).eq("id", convId));
    },
    async insertIn(m) {
      const now = new Date().toISOString();
      const { data, error } = await admin.from("support_messages").insert({ conversation_id: m.conversationId,
        contact_id: m.contactId, channel: "email", direction: "in", sender: "contact", body: m.body.slice(0, BODY_MAX),
        email_message_id: m.emailMessageId, email_refs: m.refs, attachments: m.attachments, status: "read", created_at: now })
        .select("id").single();
      if (error?.code === "23505") return null;
      if (error) throw error;
      await one(admin.from("support_conversations").update({ last_inbound_at: now }).eq("id", m.conversationId));
      return data.id;
    },
    async putFile(path, bytes, type) {
      const { error } = await admin.storage.from(bucket).upload(path, bytes, { contentType: type, upsert: true });
      if (error) throw error;
    },
    async setAttachments(id, list) {
      await one(admin.from("support_messages").update({ attachments: list }).eq("id", id));
    },
    async markBounced(refs) {
      await one(admin.from("support_messages").update({ status: "failed", error: "bounced" })
        .in("email_message_id", refs).eq("direction", "out"));
    },
  };
}
