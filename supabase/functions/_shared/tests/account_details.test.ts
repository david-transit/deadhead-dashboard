import { test } from "node:test";
import assert from "node:assert/strict";
import { sendDetails, type DetailsDeps, type Snap, type Target } from "../account/details.ts";

const NOW = new Date("2026-11-19T10:00:00Z");
const SNAP: Snap = { hash: "$2a$old", must: false, exp: null };

function fake(o: {
  target?: Partial<Target>; lock?: boolean; sentToday?: number; trySignIn?: boolean; send?: { ok: boolean; error?: string };
  restoreThrows?: boolean; setTempThrows?: boolean; logThrows?: boolean; eventThrows?: boolean;
} = {}) {
  const calls: string[] = [], events: { name: string; detail: Record<string, unknown> }[] = [];
  const st = { restored: null as Snap | null, signInEmail: "", sent: null as null | { to: string; subject: string; body: string; key: string }, pw: "" };
  const d: DetailsDeps = {
    target: async () => { calls.push("target"); return { username: "avi", name: "אבי", disabled: false, email: "avi@example.com", authEmail: "avi@users.yalla-sa.app", ...o.target }; },
    lock: async () => { calls.push("lock"); return o.lock ?? true; },
    unlock: async () => { calls.push("unlock"); },
    sentToday: async () => { calls.push("sentToday"); return o.sentToday ?? 0; },
    cap: 100,
    snapshot: async () => { calls.push("snapshot"); return SNAP; },
    restore: async (_id, s) => { calls.push("restore"); if (o.restoreThrows) throw new Error("db down"); st.restored = s; },
    setTemp: async (_id, pw) => { calls.push("setTemp"); st.pw = pw; if (o.setTempThrows) throw new Error("weak"); },
    trySignIn: async (email) => { calls.push("trySignIn"); st.signInEmail = email; return o.trySignIn ?? true; },
    send: async (m) => { calls.push("send"); st.sent = m; return o.send ?? { ok: true }; },
    log: async (_id, status) => { calls.push("log:" + status); if (o.logThrows) throw new Error("db down"); },
    event: async (name, detail) => { calls.push("event:" + name); events.push({ name, detail }); if (o.eventThrows) throw new Error("db down"); },
    warn80: async () => { calls.push("warn80"); },
    now: () => NOW,
    pw: () => "Ab3defGh5jkm",
  };
  return { d, calls, events, st };
}

test("success: order and result", async () => {
  const { d, calls, events, st } = fake();
  const out = await sendDetails(d, "u2");
  assert.deepEqual(out, { ok: true, expires_at: "2026-11-26T10:00:00.000Z" });
  assert.deepEqual(calls, ["lock", "target", "sentToday", "snapshot", "setTemp", "trySignIn", "send", "log:sent", "event:details_mail_sent", "unlock"]);
  assert.equal(st.sent!.to, "avi@example.com");
  assert.ok(st.sent!.body.includes("סיסמה זמנית: Ab3defGh5jkm"));
  assert.ok(st.sent!.body.includes("שם משתמש: avi"));
  const ev = JSON.stringify(events);
  assert.ok(!ev.includes("Ab3defGh5jkm") && !ev.includes("avi@example.com"));
});
test("disabled target", async () => {
  const { d, calls } = fake({ target: { disabled: true } });
  assert.deepEqual(await sendDetails(d, "u2"), { ok: false, error: "disabled" });
  assert.ok(!calls.includes("setTemp")); assert.equal(calls.at(-1), "unlock");
});
test("no email", async () => {
  const { d, calls } = fake({ target: { email: null } });
  assert.deepEqual(await sendDetails(d, "u2"), { ok: false, error: "no_email" });
  assert.ok(!calls.includes("setTemp")); assert.equal(calls.at(-1), "unlock");
});
test("busy", async () => {
  const { d, calls } = fake({ lock: false });
  assert.deepEqual(await sendDetails(d, "u2"), { ok: false, error: "busy" });
  assert.deepEqual(calls, ["lock"]);
});
test("quota full", async () => {
  const { d, calls } = fake({ sentToday: 90 });
  assert.deepEqual(await sendDetails(d, "u2"), { ok: false, error: "quota" });
  assert.ok(!calls.includes("snapshot") && !calls.includes("setTemp")); assert.equal(calls.at(-1), "unlock");
});
test("sign-in check fails -> restore", async () => {
  const { d, calls, st } = fake({ trySignIn: false });
  assert.deepEqual(await sendDetails(d, "u2"), { ok: false, error: "send_failed" });
  assert.deepEqual(st.restored, SNAP); assert.ok(!calls.includes("send")); assert.ok(calls.includes("log:failed"));
  assert.equal(calls.at(-1), "unlock");
});
test("Resend fails -> restore", async () => {
  const { d, calls, st } = fake({ send: { ok: false, error: "send_failed" } });
  assert.deepEqual(await sendDetails(d, "u2"), { ok: false, error: "send_failed" });
  assert.deepEqual(st.restored, SNAP); assert.ok(calls.includes("log:failed")); assert.ok(calls.includes("event:details_mail_failed"));
});
test("restore fails -> locked", async () => {
  const { d, calls } = fake({ send: { ok: false }, restoreThrows: true });
  assert.deepEqual(await sendDetails(d, "u2"), { ok: false, error: "send_failed_locked" });
  assert.ok(calls.includes("event:details_restore_failed")); assert.equal(calls.at(-1), "unlock");
});
test("sign-in uses authEmail, mail goes to contact email", async () => {
  const { d, st } = fake({ target: { authEmail: "rec@x.co", email: "c@x.co" } });
  await sendDetails(d, "u2");
  assert.equal(st.signInEmail, "rec@x.co"); assert.equal(st.sent!.to, "c@x.co");
});
test("80% warning", async () => {
  const { d, calls } = fake({ sentToday: 79 });
  await sendDetails(d, "u2");
  assert.equal(calls.filter((c) => c === "warn80").length, 1);
});
test("no 80% warning below the threshold", async () => {
  const { d, calls } = fake({ sentToday: 10 });
  await sendDetails(d, "u2");
  assert.ok(!calls.includes("warn80"));
});
test("setTemp throws -> restore, send_failed", async () => {
  const { d, calls, st } = fake({ setTempThrows: true });
  assert.deepEqual(await sendDetails(d, "u2"), { ok: false, error: "send_failed" });
  assert.deepEqual(st.restored, SNAP); assert.ok(!calls.includes("send")); assert.equal(calls.at(-1), "unlock");
});
test("fresh idempotency key per send", async () => {
  const a = fake(), b = fake();
  await sendDetails(a.d, "u2"); await sendDetails(b.d, "u2");
  assert.ok(a.st.sent!.key && a.st.sent!.key !== b.st.sent!.key);
});

test("log failure after a failed send still restores the old password", async () => {
  const { d, st } = fake({ send: { ok: false }, logThrows: true, eventThrows: true });
  assert.deepEqual(await sendDetails(d, "u2"), { ok: false, error: "send_failed" });
  assert.deepEqual(st.restored, SNAP);
});
test("restore runs before the failure is logged", async () => {
  const { d, calls } = fake({ send: { ok: false } });
  await sendDetails(d, "u2");
  assert.ok(calls.indexOf("restore") < calls.indexOf("log:failed"));
});
test("log failure after a successful send still reports ok (no second password)", async () => {
  const { d } = fake({ logThrows: true, eventThrows: true });
  assert.equal((await sendDetails(d, "u2")).ok, true);
});
