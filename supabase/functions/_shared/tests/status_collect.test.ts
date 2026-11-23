import { test } from "node:test";
import assert from "node:assert/strict";
import { collect, CATALOG, DAYS_URL, type Deps, type Figures } from "../status/collect.ts";
import type { Item } from "../status/levels.ts";

const NOW = new Date("2026-11-19T10:00:00Z");
const FIG: Figures = { wa_spend: 0, wa_cap: 20, g_day: 50, g_month: 350, mail_day: 12, mail_month: 140, mail_cap: 100,
  db_bytes: 16 * 1048576, alert_channel: "email",
  manual: CATALOG.filter(c => c.grp === "manual").map(c => ({ key: c.key, checked_on: "2026-11-19" })) };
const run = (conclusion: string, created_at: string) => ({ status: "completed", conclusion, created_at, html_url: "https://gh/run" });
function deps(over: Partial<Deps> = {}): Deps {
  return {
    figures: async () => FIG,
    text: async () => '(window.OPDAYS=window.OPDAYS||{})["derech-egged"]={"days": ["2026-11-17"]}',
    json: async (u: string) => {
      if (u === "https://api.github.com/repos/david-transit/deadhead-dashboard/actions/cache/usage") return { active_caches_size_in_bytes: 1.44 * 1073741824 };
      if (u.includes("backup-weekly")) return { workflow_runs: [run("success", "2026-11-17T08:00:00Z")] };
      if (u.includes("bus-blockers-weekly")) return { workflow_runs: [run("failure", "2026-11-17T08:00:00Z")] };
      if (u.includes("rdap")) return { events: [{ eventAction: "expiration", eventDate: "2027-11-15T00:00:00Z" }] };
      throw new Error("unexpected " + u);
    },
    ...over,
  };
}
const by = (items: Item[]) => Object.fromEntries(items.map(i => [i.key, i]));

test("all fine: 15 items in catalog order, readings", async () => {
  const items = await collect(deps(), [], NOW);
  assert.equal(items.length, 15);
  assert.deepEqual(items.map(i => i.ord), [...Array(15).keys()]);
  const b = by(items);
  assert.equal(b.mail_day.level, "ok"); assert.equal(b.mail_day.reading, "12 מתוך 100");
  assert.equal(b.google_routes.reading, "350 מתוך 4,500 · היום 50 מתוך 300");
  assert.equal(b.m_planner.title, "שרת התכנון"); // no personal names in messages (spec §3)
  assert.equal(b.gh_cache.reading, "1.4GB מתוך 10GB");
  assert.equal(b.db_size.reading, "16MB מתוך 500MB");
  assert.equal(b.wa_spend.reading, "0 ₪ מתוך 20 ₪"); assert.equal(b.wa_spend.note, "ממתין לאימות העסק");
  assert.equal(b.nightly.level, "ok"); assert.equal(b.nightly.reading, "היום האחרון: 17.11");
  assert.equal(b.blockers.level, "bad"); assert.equal(b.blockers.red_since, NOW.toISOString());
  assert.equal(b.domain.reading, "בתוקף עד 15.11.2027");
  assert.equal(b.m_cloudflare.level, "manual"); assert.equal(b.m_cloudflare.reading, "נבדק ידנית: 19.11");
});
test("GitHub 403: its three rows grey with the previous value; others fine", async () => {
  const prev = await collect(deps(), [], NOW);
  const later = new Date(NOW.getTime() + 3600000);
  const gh403 = deps({ json: async (u: string) => { if (u.includes("api.github.com")) throw new Error("403"); return deps().json(u) } });
  const b = by(await collect(gh403, prev, later));
  for (const k of ["gh_cache", "backup", "blockers"]) { assert.equal(b[k].level, "unknown"); assert.equal(b[k].unknown_since, later.toISOString()) }
  assert.equal(b.gh_cache.reading, "1.4GB מתוך 10GB");
  assert.match(b.gh_cache.note!, /^לא נבדק – \d\d:\d\d$/);
  assert.equal(b.blockers.red_since, prev.find(i => i.key === "blockers")!.red_since); // red stays remembered while grey
  assert.equal(b.domain.level, "ok"); assert.equal(b.mail_day.level, "ok");
});
test("grey for more than 24 hours turns yellow", async () => {
  const prev = (await collect(deps(), [], NOW)).map(i => i.key === "domain" ? { ...i, level: "unknown" as const, unknown_since: "2026-11-18T09:00:00Z" } : i);
  const noRdap = deps({ json: async (u: string) => { if (u.includes("rdap")) throw new Error("down"); return deps().json(u) } });
  assert.equal(by(await collect(noRdap, prev, NOW)).domain.level, "warn");
});
test("figures() fails: database rows grey, days.js and RDAP still computed", async () => {
  const b = by(await collect(deps({ figures: async () => { throw new Error("db") } }), [], NOW));
  for (const k of ["wa_spend", "google_routes", "mail_day", "mail_month", "db_size"]) assert.equal(b[k].level, "unknown");
  assert.equal(b.nightly.level, "ok"); assert.equal(b.domain.level, "ok");
});
test("manual row not checked for 31 days is yellow", async () => {
  const f = { ...FIG, manual: FIG.manual.map(m => m.key === "m_meta" ? { ...m, checked_on: "2026-10-19" } : m) };
  assert.equal(by(await collect(deps({ figures: async () => f }), [], NOW)).m_meta.level, "warn");
});
test("red keeps its red_since", async () => {
  const prev = (await collect(deps(), [], NOW)).map(i => i.key === "blockers" ? { ...i, red_since: "2026-11-18T00:00:00Z" } : i);
  assert.equal(by(await collect(deps(), prev, NOW)).blockers.red_since, "2026-11-18T00:00:00Z");
});

test("the day list is read from the public hash list (operator files are in private Storage)", () => {
  assert.equal(DAYS_URL("derech-egged"), "https://yalla-sa.app/deadhead-dashboard/data/derech-egged/hashes.json");
});
