// What happens when Meta delivers a webhook (yalla-sa support, spec §2–§4, §6): store, bill, run the menu bot, alert.
import { costIls, type Category } from "./rules.ts";
import { botStep, isOptOut, type BotState } from "./bot.ts";
import { sendAlert, sendMessage, type Deps, type SupportDb } from "./send.ts";
import type { InMsg, StatusEv } from "./meta.ts";

export interface Conversation { id: string; status: "open" | "assigned" | "closed"; assignee: string | null; bot_state: BotState | null }
export interface InboundDb extends SupportDb {
  answers(): Promise<Record<string, string>>;
  upsertContact(waId: string, name: string): Promise<string>;
  activeConversation(contactId: string): Promise<Conversation>;          // latest not closed, or a new open one
  recordInbound(convId: string, contactId: string, waId: string, wamid: string, text: string, ts: Date): Promise<boolean>; // false = duplicate
  saveConversation(convId: string, patch: Partial<Conversation>): Promise<void>;
  setOptOut(waId: string): Promise<void>;
  botRepliesToday(contactId: string, now: Date): Promise<number>;
  addSpend(wamid: string, category: string, amountIls: number): Promise<boolean>; // false = already recorded
  setStatus(wamid: string, status: string, error?: string): Promise<void>;
}
export interface InDeps extends Omit<Deps, "db"> { db: InboundDb }

const BILLABLE = new Set(["utility", "authentication", "marketing", "service"]);

export async function handleInbound(d: InDeps, ev: { messages: InMsg[]; statuses: StatusEv[] }): Promise<void> {
  const now = d.now ?? new Date();
  for (const s of ev.statuses) await onStatus(d, s);
  for (const m of ev.messages) await onMessage(d, m, now);
}

async function onStatus(d: InDeps, s: StatusEv) {
  if (["sent", "delivered", "read", "failed"].includes(s.status)) await d.db.setStatus(s.wamid, s.status, s.error);
  if (s.billable && BILLABLE.has(s.category)) {
    const settings = await d.db.settings();
    await d.db.addSpend(s.wamid, s.category, costIls(s.category as Category, settings));
  }
}

// what we keep of a message we do not store (PRD R14: no files); reactions and system notices are not kept at all
const PLACEHOLDER: Record<string, string> = {
  image: "[תמונה – לא נשמרה]", audio: "[הקלטה – לא נשמרה]", video: "[סרטון – לא נשמר]", document: "[קובץ – לא נשמר]",
  sticker: "[מדבקה]", location: "[מיקום – לא נשמר]", contacts: "[איש קשר – לא נשמר]",
};
const IGNORE = new Set(["reaction", "unsupported", "system", "ephemeral", "request_welcome"]);
const TEXT_KINDS = new Set(["text", "button", "interactive"]);
const OPTED_OUT = "הוסרת. לא נשלח לך עוד הודעות מערכת";
const FILES_NOT_KEPT = "קבצים ותמונות לא נשמרים אצלנו. אפשר לשלוח לנו רק הודעות טקסט 🙏";
const NEW_INQUIRY = "פנייה חדשה בתיבת הפניות"; // no name or number in alerts (PRD R3א)

async function onMessage(d: InDeps, m: InMsg, now: Date) {
  if (IGNORE.has(m.kind)) return;
  const isText = TEXT_KINDS.has(m.kind);
  const contactId = await d.db.upsertContact(m.from, m.name);
  const cv = await d.db.activeConversation(contactId);
  const stored = isText ? m.text : PLACEHOLDER[m.kind] ?? `[${m.kind}]`;
  if (!await d.db.recordInbound(cv.id, contactId, m.from, m.wamid, stored, m.ts)) return; // duplicate delivery
  // opt-out must always work, also while an agent handles the conversation (PRD R1א)
  if (isText && isOptOut(m.text)) {
    await sendMessage(d, { to: m.from, kind: "text", body: OPTED_OUT, category: "service", sender: "bot", conversationId: cv.id });
    await d.db.setOptOut(m.from);
    return;
  }
  if (cv.status === "assigned") return; // in the agents' queue or with an agent: the bot stays out
  if (!isText) { // a file: tell the customer once per message, without counting it as an unclear answer
    await sendMessage(d, { to: m.from, kind: "text", body: FILES_NOT_KEPT, category: "service", sender: "bot", conversationId: cv.id });
    return;
  }

  const [s, answers, used] = await Promise.all([d.db.settings(), d.db.answers(), d.db.botRepliesToday(contactId, now)]);
  const out = botStep({ text: m.text, state: cv.bot_state, now, hours: s.hours, answers,
    aiLeft: 0, menuLeft: s.menu_daily_per_contact - used });
  for (const body of out.replies) {
    await sendMessage(d, { to: m.from, kind: "text", body, category: "service", sender: "bot", conversationId: cv.id });
  }
  if (out.optOut) await d.db.setOptOut(m.from);
  await d.db.saveConversation(cv.id, out.handoff ? { bot_state: out.state, status: "assigned", assignee: null } : { bot_state: out.state });
  if (out.handoff) await sendAlert(d, NEW_INQUIRY);
}
