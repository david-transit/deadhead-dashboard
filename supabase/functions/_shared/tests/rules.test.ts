// node --test supabase/functions/_shared/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { normPhone, costIls, budgetLevel, sendBlock, spendOnce, type Settings } from "../rules.ts";

const S: Settings = {
  monthly_cap_ils: 20, usd_ils: 3.7, ai_daily_per_contact: 20, menu_daily_per_contact: 50,
  rates: { utility: 0.0053, authentication: 0.0053, marketing: 0.0353, service: 0 },
};
const now = new Date("2026-11-18T10:00:00Z");
const H = 3600_000;
const base = { kind: "template" as const, category: "utility" as const, optedOut: false, consent: true,
  lastInboundAt: null, now, spentIls: 0, s: S };

test("normPhone: Israeli local and international forms map to one id", () => {
  assert.equal(normPhone("050-123-4567"), "972501234567");
  assert.equal(normPhone("+972 50 1234567"), "972501234567");
  assert.equal(normPhone("972501234567"), "972501234567");
  assert.equal(normPhone("12"), null);
  assert.equal(normPhone(""), null);
});

test("costIls: utility = rate × usd_ils", () => {
  assert.ok(Math.abs(costIls("utility", S) - 0.0053 * 3.7) < 1e-9);
  assert.equal(costIls("service", S), 0);
});

test("budgetLevel: ok below 80%, warn80 from 80%, over from 100%", () => {
  assert.equal(budgetLevel(15.9, S), "ok");
  assert.equal(budgetLevel(16, S), "warn80");
  assert.equal(budgetLevel(19.99, S), "warn80");
  assert.equal(budgetLevel(20, S), "over");
});

test("sendBlock: opted-out blocks everything, even authentication", () => {
  assert.equal(sendBlock({ ...base, optedOut: true }), "opted_out");
  assert.equal(sendBlock({ ...base, optedOut: true, category: "authentication" }), "opted_out");
});

test("sendBlock: an opted-out person who writes to us still gets replies inside the 24h window (PRD R1א)", () => {
  const text = { ...base, kind: "text" as const, category: "service" as const, optedOut: true,
    lastInboundAt: new Date(now.getTime() - H) };
  assert.equal(sendBlock(text), null);
});

test("sendBlock: template without consent is blocked, except authentication", () => {
  assert.equal(sendBlock({ ...base, consent: false }), "no_consent");
  assert.equal(sendBlock({ ...base, consent: false, category: "authentication" }), null);
});

test("sendBlock: free text only inside the 24h window", () => {
  const text = { ...base, kind: "text" as const, category: "service" as const };
  assert.equal(sendBlock({ ...text, lastInboundAt: new Date(now.getTime() - 24 * H - 1) }), "window_closed");
  assert.equal(sendBlock({ ...text, lastInboundAt: new Date(now.getTime() - 24 * H + 60_000) }), null);
  assert.equal(sendBlock({ ...text, lastInboundAt: null }), "window_closed");
});

test("sendBlock: full budget blocks paid messages but not login codes or free replies", () => {
  assert.equal(sendBlock({ ...base, spentIls: 20 }), "budget_exceeded");
  assert.equal(sendBlock({ ...base, spentIls: 20, category: "authentication" }), null);
  const text = { ...base, kind: "text" as const, category: "service" as const, lastInboundAt: new Date(now.getTime() - H) };
  assert.equal(sendBlock({ ...text, spentIls: 20 }), null);
});

test("spendOnce: true only the first time for a message id", () => {
  const seen = new Set<string>();
  assert.equal(spendOnce(seen, "wamid.A"), true);
  assert.equal(spendOnce(seen, "wamid.A"), false);
  assert.equal(spendOnce(seen, "wamid.B"), true);
});
