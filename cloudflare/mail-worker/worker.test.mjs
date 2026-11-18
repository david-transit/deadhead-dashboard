import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";

const env = { INBOUND_URL: "https://x.supabase.co/functions/v1/mail_inbound", MAIL_INBOUND_KEY: "K", BACKUP_TO: "backup@gmail.com" };
function msg(rawSize = 1000) {
  const forwards = [];
  return { forwards, from: "moshe@gmail.com", to: "support@yalla-sa.app", rawSize, raw: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }),
    headers: { get: (k) => (k === "subject" ? "שאלה" : null) }, forward: async (to) => { forwards.push(to); } };
}
function withFetch(fn) {
  const calls = []; const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return fn(); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test("200: posted with the key, no forward", async () => {
  const f = withFetch(() => new Response("{}", { status: 200 }));
  const m = msg(); await worker.email(m, env, {}); f.restore();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, env.INBOUND_URL);
  assert.equal(f.calls[0].init.headers["x-mail-key"], "K");
  assert.equal(f.calls[0].init.headers["content-type"], "message/rfc822");
  assert.deepEqual(m.forwards, []);
});
test("500: forwarded to the backup", async () => {
  const f = withFetch(() => new Response("", { status: 500 }));
  const m = msg(); await worker.email(m, env, {}); f.restore();
  assert.deepEqual(m.forwards, ["backup@gmail.com"]);
});
test("fetch throws: forwarded to the backup", async () => {
  const f = withFetch(() => { throw new Error("down"); });
  const m = msg(); await worker.email(m, env, {}); f.restore();
  assert.deepEqual(m.forwards, ["backup@gmail.com"]);
});
test("over 12MB: forwarded, and a JSON notice posted", async () => {
  const f = withFetch(() => new Response("{}", { status: 200 }));
  const m = msg(13 * 1024 * 1024); await worker.email(m, env, {}); f.restore();
  assert.deepEqual(m.forwards, ["backup@gmail.com"]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { oversize: true, from: "moshe@gmail.com", subject: "שאלה", size: 13 * 1024 * 1024 });
});
