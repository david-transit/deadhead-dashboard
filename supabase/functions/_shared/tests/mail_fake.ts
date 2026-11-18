// In-memory MailDb + Resend fetch for tests (test utility only).
import type { MailDb } from "../mail/send.ts";

export function fakeMailDb(over: Partial<{ sentToday: number }> = {}) {
  const st = {
    sentToday: over.sentToday ?? 0,
    contacts: new Map<string, string>(),
    convs: new Map<string, { status: string; contactId: string; contactEmail: string; subject: string | null; refs: string[] }>(),
    out: [] as any[],
  };
  st.convs.set("v1", { status: "open", contactId: "c1", contactEmail: "moshe@gmail.com", subject: "שאלה",
    refs: ["<a@gmail.com>", "<b@gmail.com>"] });
  const db: MailDb = {
    sentToday: async () => st.sentToday,
    emailContact: async (email) => { const k = email.toLowerCase(); if (!st.contacts.has(k)) st.contacts.set(k, "c-" + k); return st.contacts.get(k)!; },
    thread: async (id) => { const c = st.convs.get(id); if (!c) throw new Error("not_found"); return { ...c }; },
    insertOut: async (m) => { const id = "m" + (st.out.length + 1); st.out.push({ id, ...m }); return id; },
    setOut: async (id, status, error) => { const m = st.out.find((x) => x.id === id); if (m) { m.status = status; m.error = error; } if (status === "sent") st.sentToday++; },
    markAssigned: async (id) => { const c = st.convs.get(id)!; if (c.status === "open") c.status = "assigned"; },
  };
  return { db, st };
}

export function resendFetch(status = 200) {
  const calls: { url: string; init: any; body: any }[] = [];
  const f = (async (url: string, init: any) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(status === 200 ? { id: "re_1" } : { message: "bad" }), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
