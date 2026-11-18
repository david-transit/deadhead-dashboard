// The one way to send a WhatsApp message (yalla-sa support, spec §1, §3, §6).
// Every rule (opt-out, consent, 24h window, budget) is checked here; storage goes through SupportDb,
// so this file is tested with an in-memory DB and used with Supabase in wa_send / wa_webhook.
import { budgetLevel, costIls, sendBlock, type Block, type Category, type MediaKind, type Settings } from "./rules.ts";
import { graphSend, mediaPayload, templatePayload, textPayload } from "./meta.ts";
import type { Hours } from "./bot.ts";

export interface SupportSettings extends Settings {
  alert_channel: "whatsapp" | "email" | "off"; alert_to: string | null; hours: Hours;
}
export interface Contact { id: string; consent: boolean; optedOut: boolean }
export interface NewMessage {
  to: string; conversation_id: string | null; sender: "agent" | "bot" | "system"; agent_id: string | null;
  body: string | null; template: string | null; status: "queued";
}
export interface SupportDb {
  settings(): Promise<SupportSettings>;
  contactByPhone(waId: string): Promise<Contact | null>;
  lastInboundAt(waId: string): Promise<Date | null>;
  monthSpend(): Promise<number>;
  insertMessage(m: NewMessage): Promise<string>;
  updateMessage(id: string, patch: { status: "sent" | "failed"; wa_message_id?: string; error?: string }): Promise<void>;
  markAlertSent(level: "warn80" | "over"): Promise<boolean>; // true only the first time this month
}
export interface Deps {
  db: SupportDb; cfg: { token: string; phoneId: string };
  fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: Date;
}
export interface SendReq {
  to: string; kind: "text" | "template" | "media"; body?: string;
  media?: { kind: MediaKind; id: string; filename: string; size: number }; template?: string; params?: string[]; quickReply?: string;
  category: Category; sender: "agent" | "bot" | "system"; agentId?: string; conversationId?: string;
  isAlert?: boolean;       // any alert to David: never triggers another (budget) alert
  isBudgetAlert?: boolean; // the 80%/100% alert itself: the only paid message besides login codes that passes a full budget (R11)
}
export interface SendOut { ok: boolean; block?: Block; wamid?: string; error?: string }

const BUDGET_TEXT = { warn80: "הגענו ל־80% מתקציב הוואטסאפ החודשי", over: "תקציב הוואטסאפ החודשי נוצל. הבוט החכם והודעות בתשלום נעצרו" };

export async function sendMessage(d: Deps, r: SendReq): Promise<SendOut> {
  const now = d.now ?? new Date();
  const [s, c, spent, last] = await Promise.all([d.db.settings(), d.db.contactByPhone(r.to), d.db.monthSpend(), d.db.lastInboundAt(r.to)]);
  const block = sendBlock({
    kind: r.kind === "template" ? "template" : "text", // a file is a free reply, like text
    category: r.category, optedOut: !!c?.optedOut, consent: !!c?.consent,
    lastInboundAt: last, now, spentIls: r.isBudgetAlert ? 0 : spent, s,
  });
  if (block) return { ok: false, block };

  const id = await d.db.insertMessage({
    to: r.to, conversation_id: r.conversationId ?? null, sender: r.sender, agent_id: r.agentId ?? null,
    body: r.kind === "text" ? r.body ?? "" : r.kind === "media" ? fileLabel(r.media!) : (r.params ?? []).join(" | "),
    template: r.template ?? null, status: "queued",
  });
  const payload = r.kind === "text" ? textPayload(r.to, r.body ?? "")
    : r.kind === "media" ? mediaPayload(r.to, r.media!.kind, r.media!.id, r.media!.filename)
    : templatePayload(r.to, r.template!, r.params ?? [], r.quickReply);
  const res = await graphSend(payload, d.cfg, d.fetchFn, d.sleep);
  await d.db.updateMessage(id, res.ok ? { status: "sent", wa_message_id: res.wamid } : { status: "failed", error: res.error });

  if (!r.isAlert && costIls(r.category, s) > 0) {
    const level = budgetLevel(spent + costIls(r.category, s), s);
    if (level !== "ok" && await d.db.markAlertSent(level)) await sendAlert(d, BUDGET_TEXT[level], true);
  }
  return res.ok ? { ok: true, wamid: res.wamid } : { ok: false, error: res.error };
}

// what we keep of a sent file: its name and size only (PRD R7א)
function fileLabel(m: { filename: string; size: number }): string {
  const kb = Math.max(1, Math.round(m.size / 1024));
  return `📎 ${m.filename} (${kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB"})`;
}

// Alert to David (R3) on the channel chosen in the settings. Email waits for the mail sub-project.
export async function sendAlert(d: Deps, text: string, budgetAlert = false): Promise<SendOut> {
  const s = await d.db.settings();
  if (s.alert_channel !== "whatsapp" || !s.alert_to) return { ok: false, error: `alert_channel_${s.alert_channel}` };
  return sendMessage(d, { to: s.alert_to, kind: "template", template: "alert_v1", params: [text], category: "utility", sender: "system", isAlert: true, isBudgetAlert: budgetAlert });
}
