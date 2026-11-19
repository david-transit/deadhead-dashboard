// In-memory SupportDb for tests (test utility only).
import type { SupportSettings, Contact } from "../send.ts";
import type { InboundDb } from "../inbound.ts";

export const SETTINGS: SupportSettings = {
  monthly_cap_ils: 20, usd_ils: 3.7, ai_daily_per_contact: 20, menu_daily_per_contact: 50,
  rates: { utility: 0.0053, authentication: 0.0053, marketing: 0.0353, service: 0 },
  alert_channel: "whatsapp", alert_to: "972509999999",
  hours: { days: [0, 1, 2, 3, 4], from: "08:00", to: "17:00" },
};

export function fakeDb(over: Partial<{ settings: SupportSettings; spent: number }> = {}) {
  const st = {
    settings: { ...SETTINGS, ...(over.settings ?? {}) },
    spent: over.spent ?? 0,
    contacts: new Map<string, Contact & { name?: string }>([["972509999999", { id: "c-david", consent: true, optedOut: false }]]),
    lastInbound: new Map<string, Date>(),
    messages: [] as any[],
    alerts: new Set<string>(),
    conversations: [] as any[],
    spend: [] as any[],
  };
  const answers: Record<string, string> = { "1": "תשובה 1", "2": "תשובה 2", hours_off: "קיבלנו. נחזור אליך ביום העבודה הבא" };
  const inbound = new Set<string>();
  const db: InboundDb = {
    answers: async () => answers,
    upsertContact: async (waId, name) => {
      const c = st.contacts.get(waId) ?? { id: "c-" + waId, consent: false, optedOut: false };
      c.name = name; st.contacts.set(waId, c); return c.id;
    },
    activeConversation: async (contactId) => {
      let cv = st.conversations.find((x) => x.contact_id === contactId && x.status !== "closed");
      if (!cv) { cv = { id: "cv" + (st.conversations.length + 1), contact_id: contactId, status: "open", assignee: null, bot_state: null }; st.conversations.push(cv); }
      return cv;
    },
    recordInbound: async (cvId, contactId, waId, wamid, text, ts) => {
      if (inbound.has(wamid)) return false;
      inbound.add(wamid);
      st.messages.push({ id: "in" + inbound.size, conversation_id: cvId, contact_id: contactId, direction: "in", sender: "contact", body: text, wa_message_id: wamid });
      st.lastInbound.set(waId, ts);
      return true;
    },
    saveConversation: async (cvId, patch) => { Object.assign(st.conversations.find((x) => x.id === cvId), patch); },
    setOptOut: async (waId) => { const c = st.contacts.get(waId)!; c.optedOut = true; },
    botRepliesToday: async (contactId, _now) => st.messages.filter((m) => m.sender === "bot" && m.to && st.contacts.get(m.to)?.id === contactId).length,
    addSpend: async (wamid, category, amountIls) => {
      if (st.spend.some((x) => x.wamid === wamid)) return false;
      st.spend.push({ wamid, category, amountIls }); st.spent += amountIls; return true;
    },
    setStatus: async (wamid, status, error) => {
      const m = st.messages.find((x) => x.wa_message_id === wamid);
      if (m) Object.assign(m, { status }, error ? { error } : {});
    },
    settings: async () => st.settings,
    contactByPhone: async (p) => st.contacts.get(p) ?? null,
    lastInboundAt: async (p) => st.lastInbound.get(p) ?? null,
    monthSpend: async () => st.spent,
    insertMessage: async (m) => { const id = "m" + (st.messages.length + 1); st.messages.push({ id, ...m }); return id; },
    updateMessage: async (id, patch) => { Object.assign(st.messages.find((x) => x.id === id), patch); },
    markAlertSent: async (level) => { if (st.alerts.has(level)) return false; st.alerts.add(level); return true; },
  };
  return { db, st };
}

export function okFetch() {
  let n = 0;
  const calls: any[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ messages: [{ id: "wamid." + ++n }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
export const failFetch = (async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400 })) as unknown as typeof fetch;
