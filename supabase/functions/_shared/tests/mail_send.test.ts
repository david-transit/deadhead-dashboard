import { test } from "node:test";
import assert from "node:assert/strict";
import { sendMail } from "../mail/send.ts";
import { FROM } from "../mail/template.ts";
import { fakeMailDb, resendFetch } from "./mail_fake.ts";

const brand = { logoUrl: "https://l/logo.png", siteUrl: "https://yalla-sa.app" };
function deps(o: { sentToday?: number; status?: number } = {}) {
  const { db, st } = fakeMailDb({ sentToday: o.sentToday });
  const { f, calls } = resendFetch(o.status);
  const alerts: string[] = [];
  return { d: { db, fetch: f, apiKey: "K", brand, cap: 100, alert: async (t: string) => { alerts.push(t); } }, st, calls, alerts };
}

test("reply: one Resend call with thread headers; row sent; conversation assigned", async () => {
  const { d, st, calls } = deps();
  const out = await sendMail(d, { kind: "reply", conversationId: "v1", body: "תשובה", agentId: "u1" });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, "https://api.resend.com/emails");
  assert.equal(c.init.headers.Authorization, "Bearer K");
  assert.equal(c.init.headers["Idempotency-Key"], out.id);
  assert.equal(c.body.from, FROM);
  assert.deepEqual(c.body.to, ["moshe@gmail.com"]);
  assert.equal(c.body.subject, "Re: שאלה");
  assert.equal(c.body.reply_to, "support@yalla-sa.app");
  assert.equal(c.body.headers["In-Reply-To"], "<b@gmail.com>");
  assert.equal(c.body.headers.References, "<a@gmail.com> <b@gmail.com>");
  assert.match(c.body.headers["Message-ID"], /^<[0-9a-f-]{36}@yalla-sa\.app>$/);
  assert.ok(c.body.html.includes("תשובה") && c.body.text.startsWith("תשובה"));
  const row = st.out[0];
  assert.equal(row.status, "sent");
  assert.equal(row.sender, "agent");
  assert.equal(row.agentId, "u1");
  assert.equal(row.emailMessageId, c.body.headers["Message-ID"]);
  assert.equal(st.convs.get("v1")!.status, "assigned");
});

test("Resend 422: row failed, send_failed", async () => {
  const { d, st } = deps({ status: 422 });
  const out = await sendMail(d, { kind: "reply", conversationId: "v1", body: "x", agentId: "u1" });
  assert.deepEqual({ ok: out.ok, error: out.error }, { ok: false, error: "send_failed" });
  assert.equal(st.out[0].status, "failed");
  assert.equal(st.convs.get("v1")!.status, "open");
});

test("reply at the cap: no call, quota", async () => {
  const { d, calls, st } = deps({ sentToday: 100 });
  const out = await sendMail(d, { kind: "reply", conversationId: "v1", body: "x", agentId: "u1" });
  assert.deepEqual(out, { ok: false, error: "quota" });
  assert.equal(calls.length, 0);
  assert.equal(st.out.length, 0);
});

test("alert at 90: stored queued, no call", async () => {
  const { d, calls, st } = deps({ sentToday: 90 });
  const out = await sendMail(d, { kind: "alert", to: "David@Example.com", subject: "s", body: "b" });
  assert.deepEqual(out, { ok: true, queued: true });
  assert.equal(calls.length, 0);
  assert.equal(st.out[0].status, "queued");
  assert.equal(st.out[0].sender, "system");
  assert.equal(st.out[0].contactId, "c-david@example.com");
  assert.equal(st.out[0].conversationId, null);
});

test("queued alert re-sent with its row id: no new row", async () => {
  const { d, st, calls } = deps();
  const out = await sendMail(d, { kind: "alert", to: "d@e.com", subject: "s", body: "b", rowId: "m9", emailMessageId: "<q@yalla-sa.app>" });
  assert.equal(out.ok, true);
  assert.equal(calls[0].body.headers["Message-ID"], "<q@yalla-sa.app>");
  assert.equal(calls[0].init.headers["Idempotency-Key"], "m9");
  assert.equal(st.out.length, 0);
});

test("the send that reaches 80% raises one alert", async () => {
  const { d, alerts } = deps({ sentToday: 79 });
  await sendMail(d, { kind: "reply", conversationId: "v1", body: "x", agentId: "u1" });
  assert.deepEqual(alerts, ["שימוש של 80% ממכסת המייל היומית"]);
});
