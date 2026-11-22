import { test } from "node:test";
import assert from "node:assert/strict";
import { pushAction, TEST_TEXT } from "../push_api.ts";

const EP = "https://web.push.apple.com/QAbc";
function fake(agent = true, key = "BPUB") {
  const calls: any[] = [];
  const d = {
    isAgent: async () => agent,
    upsert: async (r: any) => { calls.push(["upsert", r]); },
    remove: async (uid: string, ep: string) => { calls.push(["remove", uid, ep]); },
    sendOwn: async (uid: string, text: string) => { calls.push(["send", uid, text]); return { ok: true, sent: 1 }; },
    publicKey: () => key,
  };
  return { d, calls };
}

test("a user who is not a support agent gets not_allowed and nothing is stored", async () => {
  const { d, calls } = fake(false);
  assert.deepEqual(await pushAction(d, "u1", { action: "subscribe", endpoint: EP, keys: { p256dh: "p", auth: "a" } }), { ok: false, error: "not_allowed", status: 403 });
  assert.deepEqual(calls, []);
});

test("subscribe: stores the device for the caller, label trimmed to 40", async () => {
  const { d, calls } = fake();
  const r = await pushAction(d, "u1", { action: "subscribe", endpoint: EP, keys: { p256dh: "BPk", auth: "AUt" }, label: "x".repeat(60) });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls, [["upsert", { user_id: "u1", endpoint: EP, p256dh: "BPk", auth: "AUt", label: "x".repeat(40) }]]);
});

test("subscribe: endpoint outside the push services or missing keys -> bad_input", async () => {
  const { d, calls } = fake();
  for (const b of [{ endpoint: "https://evil.com/x", keys: { p256dh: "p", auth: "a" } }, { endpoint: EP, keys: { p256dh: "", auth: "a" } },
    { endpoint: EP }, { endpoint: EP, keys: { p256dh: "p".repeat(200), auth: "a" } }])
    assert.deepEqual(await pushAction(d, "u1", { action: "subscribe", ...b }), { ok: false, error: "bad_input", status: 400 });
  assert.deepEqual(calls, []);
});

test("unsubscribe removes only the caller's row for that endpoint", async () => {
  const { d, calls } = fake();
  assert.deepEqual(await pushAction(d, "u1", { action: "unsubscribe", endpoint: EP }), { ok: true });
  assert.deepEqual(calls, [["remove", "u1", EP]]);
});

test("test sends the fixed test text to the caller's own devices only", async () => {
  const { d, calls } = fake();
  assert.deepEqual(await pushAction(d, "u1", { action: "test" }), { ok: true, sent: 1 });
  assert.deepEqual(calls, [["send", "u1", TEST_TEXT]]);
});

test("unknown action -> bad_input", async () => {
  const { d } = fake();
  assert.deepEqual(await pushAction(d, "u1", { action: "x" }), { ok: false, error: "bad_input", status: 400 });
});

test("key returns the VAPID public key to agents; not configured -> 503", async () => {
  assert.deepEqual(await pushAction(fake().d, "u1", { action: "key" }), { ok: true, key: "BPUB" });
  assert.deepEqual(await pushAction(fake(true, "").d, "u1", { action: "key" }), { ok: false, error: "push_not_configured", status: 503 });
  assert.deepEqual(await pushAction(fake(false).d, "u1", { action: "key" }), { ok: false, error: "not_allowed", status: 403 });
});
