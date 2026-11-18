import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature, graphSend, textPayload, templatePayload, parseWebhook } from "../meta.ts";

const SECRET = "test-app-secret";
const BODY = '{"object":"whatsapp_business_account","entry":[]}';
const sig = (b: string) => "sha256=" + createHmac("sha256", SECRET).update(b).digest("hex");

test("verifySignature: correct signature passes", async () => {
  assert.equal(await verifySignature(BODY, sig(BODY), SECRET), true);
});
test("verifySignature: wrong, missing or for another body fails", async () => {
  assert.equal(await verifySignature(BODY, "sha256=" + "0".repeat(64), SECRET), false);
  assert.equal(await verifySignature(BODY, null, SECRET), false);
  assert.equal(await verifySignature(BODY + " ", sig(BODY), SECRET), false);
  assert.equal(await verifySignature(BODY, sig(BODY), ""), false);
});

const cfg = { token: "T", phoneId: "PID" };
const noSleep = async () => {};
function fakeFetch(statuses: number[], body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)];
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("graphSend: three 500s -> 3 calls, retryable failure", async () => {
  const f = fakeFetch([500, 500, 500]);
  const r = await graphSend({ a: 1 }, cfg, f.fn, noSleep);
  assert.equal(f.calls.length, 3);
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
});
test("graphSend: a 400 is not retried", async () => {
  const f = fakeFetch([400], { error: { message: "bad template" } });
  const r = await graphSend({ a: 1 }, cfg, f.fn, noSleep);
  assert.equal(f.calls.length, 1);
  assert.equal(r.ok, false);
  assert.equal(r.retryable, false);
  assert.match(r.error ?? "", /bad template/);
});
test("graphSend: 200 returns the message id and posts to the phone's messages URL with the token", async () => {
  const f = fakeFetch([200], { messages: [{ id: "wamid.X" }] });
  const r = await graphSend({ a: 1 }, cfg, f.fn, noSleep);
  assert.deepEqual(r, { ok: true, wamid: "wamid.X" });
  assert.equal(f.calls[0].url, "https://graph.facebook.com/v26.0/PID/messages");
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, "Bearer T");
});

test("textPayload / templatePayload shape", () => {
  assert.deepEqual(textPayload("972501234567", "שלום"),
    { messaging_product: "whatsapp", to: "972501234567", type: "text", text: { body: "שלום" } });
  const t = templatePayload("972501234567", "welcome_v1", ["דוד", "david"], "הסר") as any;
  assert.equal(t.template.name, "welcome_v1");
  assert.equal(t.template.language.code, "he");
  assert.deepEqual(t.template.components[0], { type: "body", parameters: [{ type: "text", text: "דוד" }, { type: "text", text: "david" }] });
  assert.deepEqual(t.template.components[1], { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "הסר" }] });
});

const hook = (value: unknown, field = "messages") => ({ object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field, value }] }] });

test("parseWebhook: text message with the sender's name", () => {
  const ev = parseWebhook(hook({
    contacts: [{ wa_id: "972501234567", profile: { name: "משה" } }],
    messages: [{ id: "wamid.IN", from: "972501234567", timestamp: "1763460000", type: "text", text: { body: "שלום" } }],
  }));
  assert.deepEqual(ev.messages, [{ wamid: "wamid.IN", from: "972501234567", name: "משה", text: "שלום", ts: new Date(1763460000 * 1000) }]);
  assert.deepEqual(ev.statuses, []);
});
test("parseWebhook: quick-reply button text is read as the message text", () => {
  const ev = parseWebhook(hook({ messages: [{ id: "w2", from: "972501234567", timestamp: "1", type: "button", button: { text: "הסר", payload: "הסר" } }] }));
  assert.equal(ev.messages[0].text, "הסר");
});
test("parseWebhook: billable sent status with category", () => {
  const ev = parseWebhook(hook({ statuses: [{ id: "wamid.OUT", status: "sent", pricing: { billable: true, category: "utility" } }] }));
  assert.deepEqual(ev.statuses, [{ wamid: "wamid.OUT", status: "sent", billable: true, category: "utility" }]);
});
test("parseWebhook: failed status carries the error; other fields are ignored", () => {
  const ev = parseWebhook(hook({ statuses: [{ id: "w3", status: "failed", errors: [{ title: "Re-engagement message" }] }] }));
  assert.equal(ev.statuses[0].error, "Re-engagement message");
  assert.deepEqual(parseWebhook(hook({ x: 1 }, "account_update")), { messages: [], statuses: [] });
  assert.deepEqual(parseWebhook(null), { messages: [], statuses: [] });
});
