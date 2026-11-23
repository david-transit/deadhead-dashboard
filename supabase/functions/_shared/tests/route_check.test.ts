import { test } from "node:test";
import assert from "node:assert/strict";
import { check, kmOf, parseInput, googleBody, CAPS, ENDPOINT, type Deps } from "../route_check.ts";

const OP = "3f1c2a4b-1111-4222-8333-944455556666";
const IN = { operator_id: OP, a: [31.8, 35.2], b: [31.9, 35.3] };
function deps(over: Partial<Deps> = {}) {
  const calls: string[] = [];
  const d: Deps = {
    key: "test-key",
    allowed: async () => { calls.push("allowed"); return true; },
    take: async () => { calls.push("take"); return true; },
    post: async () => { calls.push("google"); return { routes: [{ distanceMeters: 5890, duration: "660s", polyline: { encodedPolyline: "abc" } }] }; },
    ...over,
  };
  return { d, calls };
}

test("happy path: Google's km to one decimal, only the km is returned", async () => {
  const { d, calls } = deps();
  const r = await check(IN, d);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, km: 5.9 });
  assert.deepEqual(calls, ["allowed", "take", "google"]);
});

test("the request asks Google only for the distance (field mask), driving, no traffic", async () => {
  let seen: { url?: string; body?: unknown; h?: Record<string, string> } = {};
  const { d } = deps({ post: async (url, body, h) => { seen = { url, body, h }; return { routes: [] }; } });
  await check(IN, d);
  assert.equal(seen.url, ENDPOINT);
  assert.equal(seen.h!["X-Goog-FieldMask"], "routes.distanceMeters");
  assert.deepEqual(seen.body, googleBody([31.8, 35.2], [31.9, 35.3]));
  assert.equal((seen.body as { travelMode: string }).travelMode, "DRIVE");
});

test("no permission: 403, no quota spent, Google not called", async () => {
  const { d, calls } = deps({ allowed: async () => false });
  const r = await check(IN, d);
  assert.equal(r.status, 403);
  assert.deepEqual(calls, []);
});

test("quota used up: 429, Google not called", async () => {
  const { d, calls } = deps({ take: async () => { calls.push("take"); return false; } });
  const r = await check(IN, d);
  assert.equal(r.status, 429);
  assert.ok(!calls.includes("google"));
});

test("the quota uses the control panel's caps", async () => {
  let got: unknown;
  const { d } = deps({ take: async (c) => { got = c; return true; } });
  await check(IN, d);
  assert.deepEqual(got, { day: 300, month: 4500 });
  assert.deepEqual(CAPS, { day: 300, month: 4500 });
});

test("no key on the server: 503 before anything else", async () => {
  const { d, calls } = deps({ key: "" });
  assert.equal((await check(IN, d)).status, 503);
  assert.deepEqual(calls, []);
});

test("bad input: 400 (bad operator id, outside Israel, not numbers)", async () => {
  const { d, calls } = deps();
  for (const x of [null, {}, { ...IN, operator_id: "x" }, { ...IN, a: [40, 35] }, { ...IN, b: ["31.9", 35.3] }, { ...IN, a: [31.8] }])
    assert.equal((await check(x, d)).status, 400);
  assert.deepEqual(calls, []);
  assert.deepEqual(parseInput(IN), IN);
});

test("Google error: 502, and the error text (which could hold the request) is not passed on", async () => {
  const { d } = deps({ post: async () => { throw new Error("secret detail test-key"); } });
  const r = await check(IN, d);
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { error: "google_error" });
});

test("no route from Google: km null", async () => {
  assert.equal(kmOf({}), null);
  assert.equal(kmOf({ routes: [] }), null);
  assert.equal(kmOf({ routes: [{ distanceMeters: 0 }] }), null);
  assert.equal(kmOf(null), null);
  assert.equal(kmOf({ routes: [{ distanceMeters: 12345 }] }), 12.3);
});

test("nothing from Google is logged", async () => {
  const seen: unknown[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) (console as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => seen.push(a);
  try { await check(IN, deps().d); } finally { Object.assign(console, orig); }
  assert.equal(seen.length, 0);
});

test("the Edge Function source keeps no Google value: no insert/upsert/update, no-store, no logging of the result", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../../route_check/index.ts", import.meta.url), "utf8");
  assert.ok(!/\.(insert|upsert|update)\(/.test(src), "no writes");
  assert.ok(/"Cache-Control": "no-store"/.test(src));
  assert.ok(!/console\.\w+\([^)]*(km|body|r\.body|data)\b/.test(src), "no value in a log line");
  const lib = fs.readFileSync(new URL("../route_check.ts", import.meta.url), "utf8");
  assert.ok(!/console\./.test(lib.replace(/^\s*\/\/.*$/gm, "")));
});
