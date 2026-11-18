// MailDb on Supabase (service role: RLS is bypassed, so every caller is checked in the function first). Email spec §2.
// deno-lint-ignore-file no-explicit-any
import type { MailDb } from "./send.ts";

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
