import { test } from "node:test";
import assert from "node:assert/strict";
import { sendMessage, sendAlert } from "../send.ts";
import { fakeDb, okFetch, failFetch } from "./fakedb.ts";

const cfg = { token: "T", phoneId: "P" };
const now = new Date("2026-11-19T10:00:00Z");
const USER = "972501234567";
const tpl = { to: USER, kind: "template" as const, template: "welcome_v1", params: ["דוד"], category: "utility" as const, sender: "system" as const };

test("sendMessage: a blocked message never reaches Meta and returns the reason", async () => {
  const { db, st } = fakeDb();
  st.contacts.set(USER, { id: "c1", consent: true, optedOut: true });
  const f = okFetch();
  const r = await sendMessage({ db, cfg, fetchFn: f.fn, now }, tpl);
  assert.deepEqual(r, { ok: false, block: "opted_out" });
  assert.equal(f.calls.length, 0);
  assert.equal(st.messages.length, 0);
});

test("sendMessage: unknown number without consent is blocked for templates", async () => {
  const { db } = fakeDb();
  const r = await sendMessage({ db, cfg, fetchFn: okFetch().fn, now }, tpl);
  assert.equal(r.block, "no_consent");
});

test("sendMessage: success stores queued then sent with the message id", async () => {
  const { db, st } = fakeDb();
  st.contacts.set(USER, { id: "c1", consent: true, optedOut: false });
  const f = okFetch();
  const r = await sendMessage({ db, cfg, fetchFn: f.fn, now }, tpl);
  assert.equal(r.ok, true);
  assert.equal(r.wamid, "wamid.1");
  assert.equal(st.messages.length, 1);
  assert.equal(st.messages[0].status, "sent");
  assert.equal(st.messages[0].wa_message_id, "wamid.1");
  assert.equal(st.messages[0].template, "welcome_v1");
  assert.equal(f.calls[0].template.name, "welcome_v1");
});

test("sendMessage: Meta failure marks the message failed with the error", async () => {
  const { db, st } = fakeDb();
  st.contacts.set(USER, { id: "c1", consent: true, optedOut: false });
  const r = await sendMessage({ db, cfg, fetchFn: failFetch, now }, tpl);
  assert.equal(r.ok, false);
  assert.equal(st.messages[0].status, "failed");
  assert.match(st.messages[0].error, /boom/);
});

test("sendMessage: an agent's free-text reply inside 24h is sent as text", async () => {
  const { db, st } = fakeDb();
  st.contacts.set(USER, { id: "c1", consent: false, optedOut: false });
  st.lastInbound.set(USER, new Date(now.getTime() - 3600_000));
  const f = okFetch();
  const r = await sendMessage({ db, cfg, fetchFn: f.fn, now },
    { to: USER, kind: "text", body: "שלום", category: "service", sender: "agent", agentId: "u1", conversationId: "cv1" });
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls[0].text, { body: "שלום" });
  assert.equal(st.messages[0].sender, "agent");
  assert.equal(st.messages[0].conversation_id, "cv1");
});

test("sendMessage: crossing 80% sends one budget alert to David per month", async () => {
  const { db, st } = fakeDb({ spent: 16 });
  st.contacts.set(USER, { id: "c1", consent: true, optedOut: false });
  const f = okFetch();
  await sendMessage({ db, cfg, fetchFn: f.fn, now }, tpl);
  await sendMessage({ db, cfg, fetchFn: f.fn, now }, tpl);
  const alerts = f.calls.filter((c) => c.template?.name === "alert_v1");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].to, "972509999999");
  assert.match(alerts[0].template.components[0].parameters[0].text, /80%/);
});

test("sendAlert: a budget alert is delivered even when the budget is full; nothing when the channel is off", async () => {
  const full = fakeDb({ spent: 25 });
  const f = okFetch();
  const r = await sendAlert({ db: full.db, cfg, fetchFn: f.fn, now }, "תקציב", true);
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].template.name, "alert_v1");
  const off = fakeDb({ settings: { ...full.st.settings, alert_channel: "off" } });
  const g = okFetch();
  const r2 = await sendAlert({ db: off.db, cfg, fetchFn: g.fn, now }, "x");
  assert.equal(r2.ok, false);
  assert.equal(g.calls.length, 0);
});

test("sendAlert (a handoff alert) is blocked when the budget is full; a budget alert still goes out (review I2)", async () => {
  const full = fakeDb({ spent: 25 });
  const f = okFetch();
  const r = await sendAlert({ db: full.db, cfg, fetchFn: f.fn, now }, "פנייה חדשה");
  assert.equal(r.block, "budget_exceeded");
  const r2 = await sendAlert({ db: full.db, cfg, fetchFn: f.fn, now }, "תקציב", true);
  assert.equal(r2.ok, true);
});
