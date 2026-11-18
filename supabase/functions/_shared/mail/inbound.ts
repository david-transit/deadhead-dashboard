// What happens when a mail reaches mail_inbound (email spec §3 "קליטה" steps 3–7; PRD-email M4–M7):
// filter, find the conversation, store, upload attachments, alert (no name, no content: M9).
import type { Mail, Verdict } from "./parse.ts";
import { pickConversation, type ThreadDb } from "./thread.ts";

export interface InboundMailDb extends ThreadDb {
  seen(emailMessageId: string): Promise<boolean>;
  emailContact(email: string, name?: string): Promise<string>;
  isBlocked(contactId: string): Promise<boolean>;
  inboundToday(contactId: string, now: Date): Promise<number>;
  insertIn(m: { conversationId: string; contactId: string; body: string; emailMessageId: string; refs: string[];
    attachments: unknown }): Promise<string | null>;               // null = duplicate email_message_id
  putFile(path: string, bytes: Uint8Array, type: string): Promise<void>;
  setAttachments(messageId: string, list: { name: string; size: number; type: string; path: string }[]): Promise<void>;
  markBounced(refs: string[]): Promise<void>;
}
export interface InDeps { db: InboundMailDb; alert: (t: string) => Promise<unknown>; now?: Date }

export const MAX_PER_DAY = 10;
export const ALERT_NEW = "פנייה חדשה במייל";
export const ALERT_REOPENED = "פנייה במייל נפתחה מחדש";
export const ALERT_OVERSIZE = "מייל גדול מ־12MB הגיע לתיבה הטכנית";
export const OVERSIZE_BODY = "המייל גדול מ־12MB ונמצא בתיבה הטכנית";
// "3.pdf" for "צילום מסך.pdf": index + a short ASCII extension, if any
export const storageName = (i: number, name: string) => `${i + 1}${(name.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0].toLowerCase()}`;
const droppedNote = (n: number) => `[היו ${n} קבצים מצורפים מעל 10MB שלא נשמרו]`;

export async function handleMail(d: InDeps, m: Mail):
  Promise<{ stored: boolean; reason?: Verdict | "blocked" | "flood" | "duplicate" }> {
  const now = d.now ?? new Date();
  if (m.verdict === "bounce") { if (m.refs.length) await d.db.markBounced(m.refs); return { stored: false, reason: "bounce" }; }
  if (m.verdict !== "ok") return { stored: false, reason: m.verdict };
  if (await d.db.seen(m.messageId)) return { stored: false, reason: "duplicate" };

  const contactId = await d.db.emailContact(m.email, m.name ?? undefined);
  if (await d.db.isBlocked(contactId)) return { stored: false, reason: "blocked" };
  if (await d.db.inboundToday(contactId, now) >= MAX_PER_DAY) return { stored: false, reason: "flood" };

  const cv = await pickConversation(d.db, contactId, m.refs, m.subject);
  const body = m.filesDropped ? `${m.text}\n\n${droppedNote(m.filesDropped)}`.trim() : m.text;
  const id = await d.db.insertIn({ conversationId: cv.id, contactId, body, emailMessageId: m.messageId, refs: m.refs,
    attachments: m.filesDropped ? { dropped: m.filesDropped } : null });
  if (!id) return { stored: false, reason: "duplicate" }; // a parallel delivery won the race

  if (m.files.length) {
    const list = [];
    for (const [i, f] of m.files.entries()) {
      const path = `${cv.id}/${id}/${storageName(i, f.name)}`; // Storage keys must be ASCII; the real name stays in the list
      await d.db.putFile(path, f.bytes, f.type);
      list.push({ name: f.name, size: f.bytes.byteLength, type: f.type, path });
    }
    await d.db.setAttachments(id, list);
  }
  if (cv.isNew) await d.alert(ALERT_NEW);
  else if (cv.reopened) await d.alert(ALERT_REOPENED);
  return { stored: true };
}

// the Worker sent the mail to the backup Gmail because it is over 12MB; open/extend a conversation so it is not lost
export async function handleOversize(d: InDeps, o: { from: string; subject: string | null; size: number }): Promise<void> {
  const contactId = await d.db.emailContact(o.from.trim().toLowerCase());
  if (await d.db.isBlocked(contactId)) return;
  const cv = await pickConversation(d.db, contactId, [], o.subject?.trim() || null);
  await d.db.insertIn({ conversationId: cv.id, contactId, body: OVERSIZE_BODY,
    emailMessageId: `<oversize-${crypto.randomUUID()}@yalla-sa.app>`, refs: [], attachments: null });
  await d.alert(ALERT_OVERSIZE);
}
