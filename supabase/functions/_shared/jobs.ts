// Background jobs of the support inbox (email spec §3 "משימות רקע"): reminders on waiting conversations (both channels,
// WhatsApp PRD R3א), queued mail alerts, and removal of attachment folders whose conversation was deleted (M17).
import { businessMs } from "./hours.ts";
import type { Hours } from "./bot.ts";

export const REMIND_AFTER_MS = 24 * 3600_000;
export const REMINDER_TEXT = "פנייה מחכה יותר מ־24 שעות פעילות";

export interface JobsDb {
  dueReminders(): Promise<{ id: string; channel: string; since: Date }[]>; // waiting for an agent, reminded_at null
  markReminded(id: string): Promise<void>;
  queuedAlerts(): Promise<{ id: string; to: string; body: string; emailMessageId: string }[]>;
  listAttachmentFolders(): Promise<string[]>;
  liveConversationIds(ids: string[]): Promise<Set<string>>;
  removeFolder(id: string): Promise<void>;
}

// when the customer started waiting: first inbound after the last reply by an agent or the bot (system mails are not replies)
export function waitingSince(msgs: { direction: string; sender: string; at: Date }[]): Date | null {
  let since: Date | null = null;
  for (const m of msgs) {
    if (m.direction === "out" && (m.sender === "agent" || m.sender === "bot")) since = null;
    else if (m.direction === "in" && !since) since = m.at;
  }
  return since;
}

export async function runReminders(d: { db: JobsDb; hours: Hours; alert: (t: string) => Promise<unknown> }, now: Date): Promise<number> {
  let n = 0;
  for (const c of await d.db.dueReminders()) {
    if (businessMs(c.since, now, d.hours) < REMIND_AFTER_MS) continue;
    await d.db.markReminded(c.id);
    await d.alert(REMINDER_TEXT);
    n++;
  }
  return n;
}

export async function flushQueued(d: { db: JobsDb; send: (r: { kind: "alert"; to: string; subject: string; body: string;
  rowId: string; emailMessageId: string }) => Promise<{ ok: boolean; queued?: boolean }> }): Promise<number> {
  let n = 0;
  for (const q of await d.db.queuedAlerts()) {
    const r = await d.send({ kind: "alert", to: q.to, subject: "יאללה־סע: התראה", body: q.body, rowId: q.id, emailMessageId: q.emailMessageId });
    if (r.queued) break; // quota still full: try next hour
    if (r.ok) n++;
  }
  return n;
}

export async function cleanupFiles(d: { db: JobsDb }): Promise<number> {
  const folders = await d.db.listAttachmentFolders();
  if (!folders.length) return 0;
  const live = await d.db.liveConversationIds(folders);
  let n = 0;
  for (const f of folders) if (!live.has(f)) { await d.db.removeFolder(f); n++; }
  return n;
}
