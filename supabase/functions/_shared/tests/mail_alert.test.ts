import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAlerter, INBOX_LINK, ALERT_SUBJECT } from "../mail/alert.ts";

function setup(s: any) {
  const calls: any[] = [];
  const alert = makeAlerter({ settings: async () => s,
    mail: async (to, subject, body, warn) => { calls.push(["mail", to, subject, body, warn]); return { ok: true }; },
    wa: async (to, text) => { calls.push(["wa", to, text]); return { ok: true }; } });
  return { alert, calls };
}
test("email channel: mail with the inbox link, 80% warning allowed", async () => {
  const { alert, calls } = setup({ alert_channel: "email", alert_email: "d@e.com" });
  await alert("פנייה חדשה במייל");
  assert.deepEqual(calls, [["mail", "d@e.com", ALERT_SUBJECT, `פנייה חדשה במייל\n\n${INBOX_LINK}`, true]]);
});
test("whatsapp channel (default): wa template", async () => {
  const { alert, calls } = setup({ alert_channel: "whatsapp", alert_to: "972509999999" });
  await alert("x");
  assert.deepEqual(calls, [["wa", "972509999999", "x"]]);
});
test("off, or channel without a target: nothing sent", async () => {
  for (const s of [{ alert_channel: "off" }, { alert_channel: "email" }, { alert_channel: "whatsapp" }]) {
    const { alert, calls } = setup(s);
    assert.equal((await alert("x") as any).ok, false);
    assert.equal(calls.length, 0);
  }
});

test("push channel (M20): push only, with the bare text; no mail, no WhatsApp, no quota", async () => {
  const calls: any[] = [];
  const alert = makeAlerter({ settings: async () => ({ alert_channel: "push", alert_to: "972500000000", alert_email: "d@x.com" }),
    mail: async () => { calls.push("mail"); return { ok: true }; },
    wa: async () => { calls.push("wa"); return { ok: true }; },
    push: async (text) => { calls.push(["push", text]); return { ok: true, sent: 2 }; } });
  assert.deepEqual(await alert("פנייה חדשה במייל"), { ok: true, sent: 2 });
  assert.deepEqual(calls, [["push", "פנייה חדשה במייל"]]);
});

test("push channel without a push sender -> push_not_configured", async () => {
  const alert = makeAlerter({ settings: async () => ({ alert_channel: "push" }), mail: async () => ({}), wa: async () => ({}) });
  assert.deepEqual(await alert("x"), { ok: false, error: "push_not_configured" });
});
