// The only way to send mail (yalla-sa support, email spec §3 "שליחה"): quota, signature, thread headers, Resend, record.
import { FROM, renderMail, replySubject, type Brand } from "./template.ts";
import { quotaDecision } from "./quota.ts";

export interface MailDb {
  sentToday(): Promise<number>;
  emailContact(email: string, name?: string): Promise<string>;
  thread(convId: string): Promise<{ contactId: string; contactEmail: string; subject: string | null; refs: string[] }>;
  insertOut(m: { conversationId: string | null; contactId: string; sender: "agent" | "system"; agentId?: string;
    body: string; status: "queued" | "sent" | "failed"; emailMessageId: string; error?: string }): Promise<string>;
  setOut(id: string, status: "sent" | "failed", error?: string): Promise<void>;
  markAssigned(convId: string, agentId?: string): Promise<void>; // open -> assigned; assignee = agent when none
}
export interface MailDeps { db: MailDb; fetch: typeof fetch; apiKey: string; brand: Brand; cap: number; now?: Date;
  alert?: (text: string) => Promise<unknown> }
export type MailReq =
  | { kind: "reply"; conversationId: string; body: string; agentId: string }
  | { kind: "alert"; to: string; subject: string; body: string; rowId?: string; emailMessageId?: string };
export interface MailOut { ok: boolean; id?: string; queued?: boolean; error?: string }

export const RESEND_URL = "https://api.resend.com/emails";
export const REPLY_TO = "support@yalla-sa.app";
export const WARN80_TEXT = "שימוש של 80% ממכסת המייל היומית";
export const newMessageId = () => `<${crypto.randomUUID()}@yalla-sa.app>`;

export async function sendMail(d: MailDeps, r: MailReq): Promise<MailOut> {
  const q = quotaDecision(r.kind, await d.db.sentToday(), d.cap);

  let to: string, subject: string, refs: string[] = [], contactId: string, conversationId: string | null = null;
  if (r.kind === "reply") {
    const t = await d.db.thread(r.conversationId);
    to = t.contactEmail; subject = replySubject(t.subject); refs = t.refs; contactId = t.contactId; conversationId = r.conversationId;
  } else {
    to = r.to.trim().toLowerCase(); subject = r.subject;
    contactId = r.rowId ? "" : await d.db.emailContact(to);
  }
  const emailMessageId = (r.kind === "alert" && r.emailMessageId) || newMessageId();
  const row = (status: "queued") => d.db.insertOut({ conversationId, contactId, sender: r.kind === "reply" ? "agent" : "system",
    agentId: r.kind === "reply" ? r.agentId : undefined, body: r.body, status, emailMessageId });

  if (!q.send) {
    if (!q.queue) return { ok: false, error: "quota" };
    if (!(r.kind === "alert" && r.rowId)) await row("queued");
    return { ok: true, queued: true };
  }

  const id = (r.kind === "alert" && r.rowId) || await row("queued");
  const { html, text } = renderMail(r.body, d.brand);
  const headers: Record<string, string> = { "Message-ID": emailMessageId };
  if (refs.length) { headers["In-Reply-To"] = refs[refs.length - 1]; headers.References = refs.join(" "); }
  let res: Response | null = null, err = "";
  try {
    res = await d.fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${d.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": id },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text, reply_to: REPLY_TO, headers }),
    });
    if (!res.ok) err = `resend_${res.status}: ${(await res.text()).slice(0, 300)}`;
  } catch (e) { err = `resend_fetch: ${String(e).slice(0, 300)}`; }

  if (err) { await d.db.setOut(id, "failed", err); return { ok: false, id, error: "send_failed" }; }
  await d.db.setOut(id, "sent");
  if (conversationId) await d.db.markAssigned(conversationId, r.kind === "reply" ? r.agentId : undefined);
  if (q.warn80 && d.alert) await d.alert(WARN80_TEXT);
  return { ok: true, id };
}
