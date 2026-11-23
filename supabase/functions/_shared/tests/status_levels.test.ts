import { test } from "node:test";
import assert from "node:assert/strict";
import { pctLevel, worst, ilDate, ilHour, lastDay, nightlyLevel, runSummary, rdapExpiry, domainLevel, manualLevel } from "../status/levels.ts";

const NOW = new Date("2026-11-19T10:00:00Z");
const run = (status: string, conclusion: string | null, created_at: string) => ({ status, conclusion, created_at, html_url: "https://github.com/x/runs/" + created_at });

test("pctLevel: thresholds 80% / 95%, no cap = unknown", () => {
  assert.equal(pctLevel(79, 100), "ok");
  assert.equal(pctLevel(80, 100), "warn");
  assert.equal(pctLevel(94.9, 100), "warn");
  assert.equal(pctLevel(95, 100), "bad");
  assert.equal(pctLevel(5, 0), "unknown");
  assert.equal(pctLevel(5, null), "unknown");
});
test("worst: bad > warn > unknown > ok", () => {
  assert.equal(worst("ok", "unknown", "warn"), "warn");
  assert.equal(worst("ok", "unknown"), "unknown");
  assert.equal(worst("warn", "bad"), "bad");
});
test("Israel date and hour", () => {
  assert.equal(ilDate(new Date("2026-11-19T22:30:00Z")), "2026-11-20");
  assert.equal(ilHour(new Date("2026-11-19T06:05:00Z")), 8);
});
test("lastDay from days.js", () => {
  assert.equal(lastDay('(window.OPDAYS=window.OPDAYS||{})["derech-egged"]={"days": ["2026-11-16", "2026-11-17"], "ver": {}}'), "2026-11-17");
  assert.equal(lastDay("garbage"), null);
  assert.equal(lastDay('{"2026-11-16": "ab", "2026-11-21": "cd"}'), "2026-11-21");   // hashes.json (files in Storage)
  assert.equal(lastDay("{}"), null);
  assert.equal(lastDay('(window.OPDAYS=window.OPDAYS||{})["x"]={"days": []}'), null);
});
test("nightlyLevel: <=2 days ok, 3 warn, >=4 bad", () => {
  assert.equal(nightlyLevel("2026-11-17", "2026-11-19"), "ok");
  assert.equal(nightlyLevel("2026-11-16", "2026-11-19"), "warn");
  assert.equal(nightlyLevel("2026-11-15", "2026-11-19"), "bad");
  assert.equal(nightlyLevel(null, "2026-11-19"), "unknown");
});
test("runSummary: skip running, cancelled = failed, stale = did not run", () => {
  assert.deepEqual(runSummary([run("in_progress", null, "2026-11-19T09:00:00Z"), run("completed", "success", "2026-11-17T08:00:00Z")], NOW),
    { level: "ok", reading: "הצליח · 17.11", link: null });
  const c = run("completed", "cancelled", "2026-11-17T08:00:00Z");
  assert.deepEqual(runSummary([c], NOW), { level: "bad", reading: "הריצה האחרונה נכשלה · 17.11", link: c.html_url });
  assert.deepEqual(runSummary([run("completed", "success", "2026-11-10T08:00:00Z")], NOW), { level: "bad", reading: "לא רץ", link: null });
  assert.deepEqual(runSummary([], NOW), { level: "bad", reading: "לא רץ", link: null });
});
test("RDAP expiry and domain level", () => {
  assert.equal(rdapExpiry({ events: [{ eventAction: "registration", eventDate: "2025-11-15T00:00:00Z" }, { eventAction: "expiration", eventDate: "2027-11-15T00:00:00Z" }] }), "2027-11-15");
  assert.equal(rdapExpiry({}), null);
  assert.equal(domainLevel("2027-11-15", new Date("2027-10-20T00:00:00Z")), "warn");
  assert.equal(domainLevel("2027-11-15", new Date("2027-11-10T00:00:00Z")), "bad");
  assert.equal(domainLevel("2027-11-15", NOW), "ok");
  assert.equal(domainLevel(null, NOW), "unknown");
});
test("manualLevel: warn after 30 days", () => {
  assert.equal(manualLevel("2026-11-19", "2026-12-18"), "manual");
  assert.equal(manualLevel("2026-11-19", "2026-12-20"), "warn");
  assert.equal(manualLevel(null, "2026-12-20"), "warn");
});
