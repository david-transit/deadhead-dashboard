import { test } from "node:test";
import assert from "node:assert/strict";
import { quotaDecision } from "../mail/quota.ts";

test("alerts stop 10 before the cap and are queued", () => {
  assert.deepEqual(quotaDecision("alert", 89, 100), { send: true, warn80: false });
  assert.deepEqual(quotaDecision("alert", 90, 100), { send: false, queue: true });
});
test("replies may use the whole cap, then fail without queue", () => {
  assert.deepEqual(quotaDecision("reply", 99, 100), { send: true, warn80: false });
  assert.deepEqual(quotaDecision("reply", 100, 100), { send: false, queue: false });
});
test("warn80 only on the send that reaches 80%", () => {
  assert.equal((quotaDecision("reply", 79, 100) as any).warn80, true);
  assert.equal((quotaDecision("reply", 78, 100) as any).warn80, false);
  assert.equal((quotaDecision("reply", 80, 100) as any).warn80, false);
  assert.equal((quotaDecision("alert", 79, 100) as any).warn80, true);
});
