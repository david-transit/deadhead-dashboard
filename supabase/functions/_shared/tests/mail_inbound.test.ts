import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMail, handleOversize, type InboundMailDb } from "../mail/inbound.ts";
import type { Mail } from "../mail/parse.ts";

const now = new Date("2026-11-19T10:00:00Z");
function fake(o: { blocked?: boolean; today?: number } = {}) {
  const st = { contacts: new Map<string, string>(), convs: [] as any[], msgs: [] as any[], files: [] as string[], bounced: [] as string[][],
    alerts: [] as string[], atts: new Map<string, unknown>() };
  const db: InboundMailDb = {
    seen: async (mid) => st.msgs.some((m) => m.emailMessageId === mid),
    emailContact: async (e) => { if (!st.contacts.has(e)) st.contacts.set(e, "c-" + e); return st.contacts.get(e)!; },
    isBlocked: async () => !!o.blocked,
    inboundToday: async (c) => (o.today ?? 0) + st.msgs.filter((m) => m.contactId === c).length,
    convByRefs: async (refs) => {
      const m = st.msgs.find((x) => refs.includes(x.emailMessageId));
      return m ? st.convs.find((c) => c.id === m.conversationId) : null;
    },
    openEmailConv: async (c) => st.convs.find((v) => v.contactId === c && v.status !== "closed") ?? null,
    newEmailConv: async (c, subject) => { const id = "v" + (st.convs.length + 1); st.convs.push({ id, contactId: c, subject, status: "open" }); return id; },
    reopen: async (id) => { st.convs.find((c) => c.id === id).status = "open"; },
    insertIn: async (m) => {
      if (st.msgs.some((x) => x.emailMessageId === m.emailMessageId)) return null;
      const id = "m" + (st.msgs.length + 1); st.msgs.push({ id, ...m }); return id;
    },
    putFile: async (path) => { st.files.push(path); },
    setAttachments: async (id, a) => { st.atts.set(id, a); },
    markBounced: async (refs) => { st.bounced.push(refs); },
  };
  const d = { db, alert: async (t: string) => { st.alerts.push(t); }, now };
  return { d, st };
}
const M = (o: Partial<Mail> = {}): Mail => ({ verdict: "ok", email: "moshe@gmail.com", name: "משה", subject: "שאלה", text: "שלום",
  messageId: "<m1@gmail.com>", refs: [], files: [], filesDropped: 0, ...o });

test("new ok mail: contact, conversation, one message, one alert", async () => {
  const { d, st } = fake();
  assert.deepEqual(await handleMail(d, M()), { stored: true });
  assert.equal(st.convs.length, 1);
  assert.equal(st.convs[0].subject, "שאלה");
  assert.equal(st.msgs.length, 1);
  assert.equal(st.msgs[0].body, "שלום");
  assert.deepEqual(st.alerts, ["פנייה חדשה במייל"]);
});

test("same mail twice: stored once, alerted once", async () => {
  const { d, st } = fake();
  await handleMail(d, M());
  assert.deepEqual(await handleMail(d, M()), { stored: false, reason: "duplicate" });
  assert.equal(st.msgs.length, 1);
  assert.equal(st.convs.length, 1);
  assert.equal(st.alerts.length, 1);
});

test("spoofed, auto, own domain: nothing stored, no alert", async () => {
  for (const v of ["spoofed", "auto", "own_domain"] as const) {
    const { d, st } = fake();
    assert.deepEqual(await handleMail(d, M({ verdict: v })), { stored: false, reason: v });
    assert.equal(st.msgs.length + st.convs.length + st.alerts.length + st.contacts.size, 0);
  }
});

test("bounce with our ref: outgoing marked, no conversation", async () => {
  const { d, st } = fake();
  await handleMail(d, M({ verdict: "bounce", refs: ["<out@yalla-sa.app>"] }));
  assert.deepEqual(st.bounced, [["<out@yalla-sa.app>"]]);
  assert.equal(st.convs.length, 0);
});

test("blocked contact: not stored, no alert", async () => {
  const { d, st } = fake({ blocked: true });
  assert.deepEqual(await handleMail(d, M()), { stored: false, reason: "blocked" });
  assert.equal(st.alerts.length, 0);
});

test("11th mail of the day from one address: flood", async () => {
  const { d, st } = fake({ today: 10 });
  assert.deepEqual(await handleMail(d, M()), { stored: false, reason: "flood" });
  assert.equal(st.msgs.length, 0);
});

test("follow-up in an open conversation: no new alert", async () => {
  const { d, st } = fake();
  await handleMail(d, M());
  await handleMail(d, M({ messageId: "<m2@gmail.com>", refs: ["<m1@gmail.com>"] }));
  assert.equal(st.convs.length, 1);
  assert.equal(st.msgs.length, 2);
  assert.equal(st.alerts.length, 1);
});

test("mail into a closed conversation: reopened + alert", async () => {
  const { d, st } = fake();
  await handleMail(d, M());
  st.convs[0].status = "closed";
  await handleMail(d, M({ messageId: "<m2@gmail.com>", refs: ["<m1@gmail.com>"] }));
  assert.equal(st.convs[0].status, "open");
  assert.deepEqual(st.alerts, ["פנייה חדשה במייל", "פנייה במייל נפתחה מחדש"]);
});

test("two files: stored at <conv>/<message>/<n.ext> (ASCII keys) and listed on the message", async () => {
  const { d, st } = fake();
  const b = new Uint8Array([1, 2, 3]);
  await handleMail(d, M({ files: [{ name: "a.png", type: "image/png", bytes: b }, { name: "צילום.pdf", type: "application/pdf", bytes: b }] }));
  assert.deepEqual(st.files, ["v1/m1/1.png", "v1/m1/2.pdf"]);
  assert.deepEqual(st.atts.get("m1"), [{ name: "a.png", size: 3, type: "image/png", path: "v1/m1/1.png" },
    { name: "צילום.pdf", size: 3, type: "application/pdf", path: "v1/m1/2.pdf" }]);
});

test("dropped files: note at the end of the body, recorded on the message", async () => {
  const { d, st } = fake();
  await handleMail(d, M({ filesDropped: 2 }));
  assert.ok(st.msgs[0].body.endsWith("[היו 2 קבצים מצורפים מעל 10MB שלא נשמרו]"));
  assert.deepEqual(st.msgs[0].attachments, { dropped: 2 });
});

test("oversize notice: conversation with the note and an alert", async () => {
  const { d, st } = fake();
  await handleOversize(d, { from: "Moshe@Gmail.com", subject: "קבצים", size: 20_000_000 });
  assert.equal(st.convs.length, 1);
  assert.equal(st.msgs[0].body, "המייל גדול מ־12MB ונמצא בתיבה הטכנית");
  assert.equal(st.msgs[0].contactId, "c-moshe@gmail.com");
  assert.deepEqual(st.alerts, ["מייל גדול מ־12MB הגיע לתיבה הטכנית"]);
});

test("mail without a usable From address: dropped quietly, no contact, no alert", async () => {
  const { d, st } = fake();
  assert.deepEqual(await handleMail(d, M({ email: "" })), { stored: false, reason: "no_address" });
  assert.deepEqual(await handleMail(d, M({ email: "undisclosed-recipients:;", messageId: "<m9@x>" })), { stored: false, reason: "no_address" });
  assert.equal(st.contacts.size + st.alerts.length, 0);
});
