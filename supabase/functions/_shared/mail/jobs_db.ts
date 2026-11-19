// JobsDb on Supabase (service role). Email spec §3 "משימות רקע".
// deno-lint-ignore-file no-explicit-any
import { waitingSince, type JobsDb } from "../jobs.ts";
import { one } from "./db.ts";

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
