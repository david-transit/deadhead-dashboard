// In-memory SupportDb for tests (test utility only).
import type { SupportDb, SupportSettings, Contact } from "../send.ts";

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
  const db: SupportDb = {
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
