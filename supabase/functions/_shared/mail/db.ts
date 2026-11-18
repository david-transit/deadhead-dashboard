// MailDb on Supabase (service role: RLS is bypassed, so every caller is checked in the function first). Email spec §2.
// deno-lint-ignore-file no-explicit-any
import type { MailDb } from "./send.ts";
import type { InboundMailDb } from "./inbound.ts";
import { waitingSince, type JobsDb } from "../jobs.ts";

export const one = async (q: any) => { const { data, error } = await q; if (error) throw error; return data; };

export async function emailContactOn(admin: any, email: string, name?: string): Promise<string> {
  const e = email.trim().toLowerCase();
  const found = await one(admin.from("support_contacts").select("id, email_name").eq("email", e).maybeSingle());
  if (found) {
    if (name && name !== found.email_name) await one(admin.from("support_contacts").update({ email_name: name }).eq("id", found.id));
    return found.id;
  }
  const ins = await one(admin.from("support_contacts").upsert({ email: e, email_name: name ?? null }, { onConflict: "email" })
    .select("id").single());
  return ins.id;
}

export function supabaseMailDb(admin: any): MailDb {
  return {
    async sentToday() { return Number(await one(admin.rpc("support_mail_sent_today"))) || 0; },
    emailContact: (email, name) => emailContactOn(admin, email, name),
    async thread(convId) {
      const cv = await one(admin.from("support_conversations").select("id, subject, contact_id, support_contacts(email)")
        .eq("id", convId).eq("channel", "email").maybeSingle());
      if (!cv?.support_contacts?.email) throw new Error("not_found");
      const msgs = await one(admin.from("support_messages").select("email_message_id").eq("conversation_id", convId)
        .not("email_message_id", "is", null).order("created_at"));
      return { contactId: cv.contact_id, contactEmail: cv.support_contacts.email, subject: cv.subject,
        refs: msgs.map((m: any) => m.email_message_id) };
    },
    async insertOut(m) {
      const r = await one(admin.from("support_messages").insert({ conversation_id: m.conversationId, contact_id: m.contactId,
        channel: "email", direction: "out", sender: m.sender, agent_id: m.agentId ?? null, body: m.body, status: m.status,
        email_message_id: m.emailMessageId, error: m.error ?? null }).select("id").single());
      return r.id;
    },
    async setOut(id, status, error) {
      await one(admin.from("support_messages").update({ status, error: error ?? null }).eq("id", id));
    },
    async markAssigned(convId, agentId) {
      const cv = await one(admin.from("support_conversations").select("status, assignee").eq("id", convId).single());
      if (cv.status === "closed") return;
      await one(admin.from("support_conversations").update({ status: "assigned", assignee: cv.assignee ?? agentId ?? null }).eq("id", convId));
    },
  };
}

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
      const r = await one(admin.from("support_conversations").insert({ contact_id: contactId, channel: "email",
        subject: subject?.slice(0, 300) ?? null, status: "open" }).select("id").single());
      return r.id;
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

export function supabaseJobsDb(admin: any, bucket = "support-attachments"): JobsDb {
  const files = admin.storage.from(bucket);
  const list = async (prefix: string) => { const { data, error } = await files.list(prefix, { limit: 1000 }); if (error) throw error; return data as any[]; };
  return {
    async dueReminders() {
      // waiting for an agent: not closed, nobody assigned, not a WhatsApp conversation still with the bot
      const convs = await one(admin.from("support_conversations").select("id, channel").neq("status", "closed")
        .is("assignee", null).is("reminded_at", null).or("channel.eq.email,status.neq.open").limit(200));
      const out = [];
      for (const c of convs) {
        const msgs = await one(admin.from("support_messages").select("direction, sender, created_at")
          .eq("conversation_id", c.id).order("created_at"));
        const since = waitingSince(msgs.map((m: any) => ({ direction: m.direction, sender: m.sender, at: new Date(m.created_at) })));
        if (since) out.push({ id: c.id, channel: c.channel, since });
      }
      return out;
    },
    async markReminded(id) { await one(admin.from("support_conversations").update({ reminded_at: new Date().toISOString() }).eq("id", id)); },
    async queuedAlerts() {
      const r = await one(admin.from("support_messages").select("id, body, email_message_id, support_contacts(email)")
        .eq("channel", "email").eq("direction", "out").eq("sender", "system").eq("status", "queued").order("created_at").limit(50));
      return r.filter((m: any) => m.support_contacts?.email)
        .map((m: any) => ({ id: m.id, to: m.support_contacts.email, body: m.body, emailMessageId: m.email_message_id }));
    },
    async listAttachmentFolders() { return (await list("")).map((f) => f.name); },
    async liveConversationIds(ids) {
      const uuids = ids.filter((i) => /^[0-9a-f-]{36}$/.test(i));
      if (!uuids.length) return new Set();
      const r = await one(admin.from("support_conversations").select("id").in("id", uuids));
      return new Set(r.map((x: any) => x.id));
    },
    async removeFolder(conv) {
      const paths: string[] = [];
      for (const m of await list(conv)) for (const f of await list(`${conv}/${m.name}`)) paths.push(`${conv}/${m.name}/${f.name}`);
      if (paths.length) { const { error } = await files.remove(paths); if (error) throw error; }
    },
  };
}
