import { test } from "node:test";
import assert from "node:assert/strict";
import { handleInbound } from "../inbound.ts";
import { MENU } from "../bot.ts";
import { fakeDb, okFetch } from "./fakedb.ts";

const cfg = { token: "T", phoneId: "P" };
const now = new Date("2026-11-19T10:00:00Z"); // Thursday 12:00 Israel time
const FROM = "972501234567";
const msg = (wamid: string, text: string) => ({ wamid, from: FROM, name: "משה", text, kind: "text", ts: now });
const ev = (messages: any[] = [], statuses: any[] = []) => ({ messages, statuses });

test("first message: contact, open conversation, the inbound message and the menu reply are stored", async () => {
  const { db, st } = fakeDb();
  const f = okFetch();
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w1", "שלום")]));
  assert.equal(st.contacts.get(FROM)?.name, "משה");
  assert.equal(st.conversations.length, 1);
  assert.equal(st.conversations[0].status, "open");
  assert.equal(st.messages.filter((m) => m.direction === "in").length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].text.body, MENU);
  assert.deepEqual(st.conversations[0].bot_state, { step: "menu", misses: 0 });
});

test("the same message delivered twice is stored and answered once", async () => {
  const { db, st } = fakeDb();
  const f = okFetch();
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w1", "שלום")]));
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w1", "שלום")]));
  assert.equal(st.messages.filter((m) => m.direction === "in").length, 1);
  assert.equal(f.calls.length, 1);
});

test("billable sent status records spend once, even when repeated", async () => {
  const { db, st } = fakeDb();
  const s = { wamid: "wo1", status: "sent", billable: true, category: "utility" };
  await handleInbound({ db, cfg, fetchFn: okFetch().fn, now }, ev([], [s]));
  await handleInbound({ db, cfg, fetchFn: okFetch().fn, now }, ev([], [s]));
  assert.equal(st.spend.length, 1);
  assert.ok(Math.abs(st.spend[0].amountIls - 0.0053 * 3.7) < 1e-9);
});

test("non-billable status records no spend; failed status marks the message failed", async () => {
  const { db, st } = fakeDb();
  st.messages.push({ id: "m9", wa_message_id: "wo2", status: "sent", direction: "out" });
  await handleInbound({ db, cfg, fetchFn: okFetch().fn, now }, ev([], [
    { wamid: "wo2", status: "delivered", billable: false, category: "service" },
    { wamid: "wo2", status: "failed", billable: false, category: "", error: "Re-engagement message" },
  ]));
  assert.equal(st.spend.length, 0);
  assert.equal(st.messages[0].status, "failed");
  assert.equal(st.messages[0].error, "Re-engagement message");
});

test("choosing 3 hands off: conversation assigned with no agent, and David gets one alert", async () => {
  const { db, st } = fakeDb();
  const f = okFetch();
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w1", "שלום")]));
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w2", "3")]));
  assert.equal(st.conversations[0].status, "assigned");
  assert.equal(st.conversations[0].assignee, null);
  const alerts = f.calls.filter((c) => c.template?.name === "alert_v1");
  assert.equal(alerts.length, 1);
  assert.doesNotMatch(alerts[0].template.components[0].parameters[0].text, /משה|972/);
});

test("no alert when the alert channel is off", async () => {
  const { db, st } = fakeDb();
  st.settings.alert_channel = "off";
  const f = okFetch();
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w1", "שלום")]));
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w2", "3")]));
  assert.equal(f.calls.filter((c) => c.template).length, 0);
});

test("the bot stays silent in a conversation that was handed to agents", async () => {
  const { db, st } = fakeDb();
  const f = okFetch();
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w1", "שלום")]));
  st.conversations[0].status = "assigned";
  st.conversations[0].assignee = "agent-1";
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w2", "עוד שאלה")]));
  assert.equal(f.calls.length, 1); // only the first menu
  assert.equal(st.messages.filter((m) => m.direction === "in").length, 2);
});

test("'הסר' marks the contact opted out and confirms", async () => {
  const { db, st } = fakeDb();
  const f = okFetch();
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w1", "הסר")]));
  assert.equal(st.contacts.get(FROM)?.optedOut, true);
  assert.equal(f.calls[0].text.body, "הוסרת. לא נשלח לך עוד הודעות מערכת");
});

test("outside hours: hours_off answer and handoff with an alert", async () => {
  const { db, st } = fakeDb();
  const f = okFetch();
  const sat = new Date("2026-11-21T10:00:00Z");
  await handleInbound({ db, cfg, fetchFn: f.fn, now: sat }, ev([{ ...msg("w1", "שלום"), ts: sat }]));
  assert.equal(f.calls[0].text.body, "קיבלנו. נחזור אליך ביום העבודה הבא");
  assert.equal(st.conversations[0].status, "assigned");
  assert.equal(f.calls.filter((c) => c.template?.name === "alert_v1").length, 1);
});

test("'הסר' works even when the conversation is already with an agent (review C1)", async () => {
  const { db, st } = fakeDb();
  const f = okFetch();
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w1", "שלום")]));
  st.conversations[0].status = "assigned"; st.conversations[0].assignee = "agent-1";
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w2", "הסר")]));
  assert.equal(st.contacts.get(FROM)?.optedOut, true);
  assert.equal(f.calls.at(-1).text.body, "הוסרת. לא נשלח לך עוד הודעות מערכת");
  assert.equal(st.conversations[0].status, "assigned");
});

test("over the budget, a handoff alert is not sent (review I2)", async () => {
  const { db, st } = fakeDb({ spent: 25 });
  const f = okFetch();
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w1", "שלום")]));
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w2", "3")]));
  assert.equal(st.conversations[0].status, "assigned");
  assert.equal(f.calls.filter((c) => c.template?.name === "alert_v1").length, 0);
});

test("a reaction is ignored by the bot; an image is stored as a placeholder and the customer is told files are not kept (review I8)", async () => {
  const { db, st } = fakeDb();
  const f = okFetch();
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([msg("w1", "שלום")]));
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([{ ...msg("w2", ""), kind: "reaction" }]));
  assert.equal(f.calls.length, 1); // only the first menu
  assert.equal(st.conversations[0].bot_state.misses, 0);
  await handleInbound({ db, cfg, fetchFn: f.fn, now }, ev([{ ...msg("w3", ""), kind: "image" }]));
  const inb = st.messages.filter((m) => m.direction === "in");
  assert.equal(inb.at(-1).body, "[תמונה – לא נשמרה]");
  assert.match(f.calls.at(-1).text.body, /רק הודעות טקסט/);
  assert.equal(st.conversations[0].bot_state.misses, 0);
});
