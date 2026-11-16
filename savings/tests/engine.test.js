// node --test savings/tests
// Synthetic fixtures (always run) + the known Derech Egged example on real data (needs the local data key; skipped otherwise).
const test = require("node:test"), assert = require("node:assert/strict");
const path = require("path"), fs = require("fs");
const E = require("../engine.js"), L = require("./load.js");

// ---------------------------------------------------------------- synthetic day
// X = shared terminal; P, Q ~9 km apart. Today A runs X→P then Q→X (empty P→Q), B runs Y(=X)→Q then P→X (empty Q→P).
// Swapping after the first trip removes both empty legs; at 12:00–13:05 both return to their own blocks at X (0 km).
const X = [31.80, 35.20], P = [31.90, 35.20], Q = [31.90, 35.29];
const T = (start, end, line, a, b, extra) => Object.assign({ kind: "trip", start, end, sched: start, line, cls: "בינעירוני",
  a, b, frm: name(a), to: name(b), km: 20 }, extra || {});
const Em = (start, end, km, min) => ({ kind: "empty", start, end, km, drive_min: min });
function name(p) { return p === X ? "מסוף X" : p === P ? "תחנה P" : p === Q ? "תחנה Q" : "מקום"; }
function synthDay(day, o) {
  o = o || {};
  const b2 = o.b2Start != null ? o.b2Start : 670; // 11:10
  const A = { veh: "A1", cls: o.clsA || "בינעירוני", items: [
    T(480, 600, "100", X, P), Em(600, 660, 12, 15), T(660, 720, "200", Q, X), Em(720, 780, 0, 0), T(780, 840, "300", X, X), Em(840, 900, 0, 0), T(900, 960, "300", X, X)] };
  const B = { veh: "B1", cls: o.clsB || "בינעירוני", items: [
    T(485, 605, "110", X, Q), Em(605, b2, 12, 15), T(b2, b2 + 60, "210", P, X), Em(b2 + 60, 785, 0, 0), T(785, 845, "310", X, X), Em(845, 905, 0, 0), T(905, 965, "310", X, X)] };
  const vehicles = o.onlyA ? [A] : [A, B];
  return { day, day_start_min: 240, routes: [], vehicles };
}
const CAND = { A: "A1", B: "B1", ka: 0, kb: 0, ja: 1, jb: 1 };
const explain = (o, ruleset, extra) => E.run(Object.assign({ day: synthDay("2026-11-10", o), others: [], ruleset: ruleset || {}, only: CAND }, extra || {})).explained;
const rule = (ev, id) => ev.rules.find(r => r.id === id);

test("synthetic: swap passes with defaults and saves both empty legs", () => {
  const ev = explain();
  assert.equal(ev.ok, true, JSON.stringify(ev.failed));
  assert.equal(ev.today_km, 24);
  assert.equal(ev.proposed_km, 0);
  assert.equal(ev.saving_km, 24);
  assert.deepEqual(ev.junctions.map(j => j.margin), [70, 55, 50, 65]);
  assert.deepEqual(ev.junctions.map(j => j.addedWait), [10, -10, -10, 10]);
  assert.equal(rule(ev, "stability").unverified, true); // no other days given
});

test("full run finds the synthetic swap, ranks it, plan uses each vehicle once", () => {
  const r = E.run({ day: synthDay("2026-11-10"), others: [], ruleset: {} });
  assert.equal(r.suggestions.length, 1);
  const s = r.suggestions[0];
  assert.equal(s.id, "s:A1:B1:0:0:1:1");
  assert.equal(s.rank, 1);
  assert.deepEqual(r.plan.ids, [s.id]);
  assert.equal(s.timelines.A.proposed.map(t => t.line).join(","), "100,210,300,300");
  assert.equal(s.timelines.B.proposed.map(t => t.line).join(","), "110,200,310,310");
});

test("margin below the minimum blocks (with the junction named)", () => {
  const ev = explain({ b2Start: 620 }); // A arrives P 10:00, B's trip leaves P 10:20 -> 20 min
  assert.equal(ev.ok, false);
  assert.ok(ev.failed.includes("margin"));
  assert.match(rule(ev, "margin").detail, /10:00: 20 < 25/);
});

test("added waiting cap", () => {
  const ev = explain({}, { operator: { max_added_wait_min: 5 } });
  assert.deepEqual(ev.failed, ["added_wait"]);
});

test("absolute waiting cap", () => {
  assert.deepEqual(explain({}, { operator: { max_wait_min: 60 } }).failed, ["max_wait"]);
  assert.equal(explain({}, { operator: { max_wait_min: null } }).ok, true);
});

test("blocked window: global, per line, span vs junction mode", () => {
  assert.deepEqual(explain({}, { operator: { blocked_windows: [{ from: "11:30", to: "11:45" }] } }).failed, ["blocked_window"]);
  // junction mode: 11:30–11:45 is inside a trip, not at a swap point
  assert.equal(explain({}, { operator: { blocked_windows: [{ from: "11:30", to: "11:45" }], blocked_mode: "junction" } }).ok, true);
  // per line: only when the window belongs to a moved line
  assert.deepEqual(explain({}, { lines: { "210": { blocked_windows: [{ from: "11:00", to: "11:30" }] } } }).failed, ["blocked_window"]);
  assert.equal(explain({}, { lines: { "999": { blocked_windows: [{ from: "11:00", to: "11:30" }] } } }).ok, true);
});

test("per-line override: specific value wins for that line, strictest wins across lines", () => {
  // line 200 (A's moved trip) may relax: margin 60 at junction B(Q,10:05→11:00, 55 min) fails with 60 only if applied
  assert.deepEqual(explain({}, { lines: { "200": { min_margin_min: 60 } } }).failed, ["margin"]);
  // a relaxed operator margin with a strict line still fails at that line's junction
  assert.deepEqual(explain({}, { operator: { min_margin_min: 10 }, lines: { "110": { min_margin_min: 56 } } }).failed, ["margin"]);
  // a line that is not involved changes nothing
  assert.equal(explain({}, { lines: { "999": { min_margin_min: 500 } } }).ok, true);
  // line switched off
  assert.deepEqual(explain({}, { lines: { "100": { enabled: true }, "210": { enabled: false } } }).failed, ["enabled"]);
});

test("cross class blocked unless allowed (operator or all moved lines)", () => {
  assert.deepEqual(explain({ clsB: "עירוני" }).failed, ["cross_class"]);
  assert.equal(explain({ clsB: "עירוני" }, { operator: { allow_cross_class: true } }).ok, true);
  // allowed by the operator but forbidden by one moved line -> blocked
  assert.deepEqual(explain({ clsB: "עירוני" }, { operator: { allow_cross_class: true }, lines: { "200": { allow_cross_class: false } } }).failed, ["cross_class"]);
});

test("cross branch blocked unless allowed; unknown branch passes with a warning", () => {
  const br = v => (v === "A1" ? "בני ברק" : "ירושלים");
  assert.deepEqual(explain({}, {}, { branchOf: br }).failed, ["cross_branch"]);
  assert.equal(explain({}, { operator: { allow_cross_branch: true } }, { branchOf: br }).ok, true);
  const ev = explain({}, {}, { branchOf: v => (v === "A1" ? "בני ברק" : "") });
  assert.equal(ev.ok, true);
  assert.equal(rule(ev, "cross_branch").warn, true);
});

test("driver-change points: required -> every swap point must be at a configured point within its hours", () => {
  assert.deepEqual(explain({}, { operator: { require_dcp: true } }).failed, ["dcp"]);
  const pts = [{ name: "P", lat: P[0], lon: P[1] }, { name: "Q", lat: Q[0], lon: Q[1] }, { name: "X", lat: X[0], lon: X[1] }];
  assert.equal(explain({}, { operator: { require_dcp: true } }, { dcp: pts }).ok, true);
  const late = pts.map(p => p.name === "Q" ? Object.assign({}, p, { from: "14:00", to: "16:00" }) : p);
  assert.deepEqual(explain({}, { operator: { require_dcp: true } }, { dcp: late }).failed, ["dcp"]);
});

test("reg. 168(a)(3): continuous driving limit and break length are configurable", () => {
  const ev = explain({}, { operator: { reg168_max_drive_min: 100 } }); // a single 120-min trip already exceeds
  assert.deepEqual(ev.failed, ["reg168"]);
  // breaks of >= 30 min everywhere -> worst stretch = longest trip (120 + 0 empty)
  assert.equal(rule(explain(), "reg168").value, 120);
  // if a break must be 90 min, the 55–70 min waits do not reset the count: 120+15(drive)+60 ... > 240
  const ev2 = explain({}, { operator: { reg168_break_min: 90 } });
  assert.ok(rule(ev2, "reg168").value > 240);
  assert.deepEqual(ev2.failed, ["reg168"]);
  assert.equal(explain({}, { operator: { reg168_break_min: 90, reg168_enabled: false } }).ok, true);
});

test("stability: k of n links must repeat on compared days (same weekday first)", () => {
  const same = synthDay("2026-11-03"), next = synthDay("2026-11-17"), other = synthDay("2026-11-11", { onlyA: true });
  let r = E.run({ day: synthDay("2026-11-10"), others: [other, same, next], ruleset: {}, only: CAND });
  assert.deepEqual(r.compareDays, ["2026-11-03", "2026-11-17"]);
  assert.equal(r.explained.stability.hits, 8);
  // only one same weekday available -> fills with the nearest weekday (11.11) where B is missing: 4 + 2 = 6 of 8 -> passes 0.75
  r = E.run({ day: synthDay("2026-11-10"), others: [other, same], ruleset: {}, only: CAND });
  assert.deepEqual(r.compareDays, ["2026-11-03", "2026-11-11"]);
  assert.equal(r.explained.stability.hits, 6);
  assert.equal(r.explained.ok, true);
  r = E.run({ day: synthDay("2026-11-10"), others: [other, same], ruleset: { operator: { stability_min_ratio: 0.8 } }, only: CAND });
  assert.deepEqual(r.explained.failed, ["stability"]);
  assert.equal(r.explained.stability.missing.length, 2);
});

test("minimum saving", () => {
  assert.deepEqual(explain({}, { operator: { min_saving_km: 30 } }).failed, ["min_saving"]);
});

test("tail swap only when allowed and both depots are known", () => {
  const ruleset = { operator: { allow_tail_swap: true } };
  let r = E.run({ day: synthDay("2026-11-10"), others: [], ruleset });
  assert.ok(!r.suggestions.some(s => s.type === "tail"), "no depots -> no tail swap");
  r = E.run({ day: synthDay("2026-11-10"), others: [], ruleset, depotOf: () => X });
  assert.ok([...r.suggestions, ...r.nearMisses].some(s => s.type === "tail") || r.stats.candidates > 1);
  r = E.run({ day: synthDay("2026-11-10"), others: [], ruleset: {}, depotOf: () => X });
  assert.ok(!r.suggestions.some(s => s.type === "tail"), "not allowed by default");
});

test("road distances: cache used when present, estimate labeled and requested otherwise", () => {
  const d2 = synthDay("2026-11-10");
  // give B a 5 km leg into P so the new link A? no: make J1 non-zero by moving B's trip start 300 m away
  d2.vehicles[1].items[2].a = [31.9027, 35.20];
  const ev = E.run({ day: d2, others: [], ruleset: {}, only: CAND });
  assert.equal(ev.explained.distance, "estimate");
  assert.equal(ev.missingRoad.length, 1);
  const road = (a, b) => (E.roadKey(a, b) === E.roadKey(P, [31.9027, 35.20]) ? { km: 0.5, min: 2 } : null);
  const ev2 = E.run({ day: d2, others: [], ruleset: {}, only: CAND, road });
  assert.equal(ev2.explained.distance, "road");
  assert.equal(ev2.explained.junctions[0].km, 0.5);
  assert.equal(ev2.missingRoad.length, 0);
  // estimate not allowed -> blocked
  assert.deepEqual(E.run({ day: d2, others: [], ruleset: { operator: { allow_estimate: false } }, only: CAND }).explained.failed, ["estimate"]);
});

test("adapter: coordinates from day.routes (older files), GPS endpoints when present, overlapping data skipped", () => {
  const d = synthDay("2026-11-10");
  for (const v of d.vehicles) for (const it of v.items) if (it.kind === "trip") { delete it.a; delete it.b; }
  d.routes = [{ line: "100", frm: "מסוף X", to: "תחנה P", o: X, d: P }, { line: "200", frm: "תחנה Q", to: "מסוף X", o: Q, d: X },
    { line: "110", frm: "מסוף X", to: "תחנה Q", o: X, d: Q }, { line: "210", frm: "תחנה P", to: "מסוף X", o: P, d: X },
    { line: "300", frm: "מסוף X", to: "מסוף X", o: X, d: X }, { line: "310", frm: "מסוף X", to: "מסוף X", o: X, d: X }];
  assert.equal(E.run({ day: d, others: [], ruleset: {}, only: CAND }).explained.saving_km, 24);
  const g = synthDay("2026-11-10"); g.vehicles[0].items[0].b_gps = [31.95, 35.20];
  assert.deepEqual(E.adaptDay(g).vehicles[0].trips[0].b, [31.95, 35.20]);
  const o = synthDay("2026-11-10"); o.vehicles[0].items[2].start = 590;
  const ad = E.adaptDay(o);
  assert.equal(ad.vehicles.length, 1);
  assert.equal(ad.skipped[0].why, "נסיעות חופפות בנתונים");
});

test("rules: normalize ignores unknown keys and operator-only keys on lines", () => {
  const R = E.normalizeRuleset({ operator: { min_margin_min: "40", bogus: 1 }, lines: { "5": { stability_days: 4, max_added_wait_min: 10 }, "6": {} } });
  assert.equal(R.operator.min_margin_min, 40);
  assert.equal(R.operator.bogus, undefined);
  assert.deepEqual(R.lines, { "5": { max_added_wait_min: 10 } });
  assert.equal(E.ruleFor(R, "max_added_wait_min", ["5", "7"]), 10);
  assert.equal(E.ruleFor(R, "max_added_wait_min", ["7"]), 30);
});

test("CSV export: BOM, Hebrew header, one row per suggestion", () => {
  const r = E.run({ day: synthDay("2026-11-10"), others: [], ruleset: {} });
  const csv = E.toCSV(r);
  assert.ok(csv.startsWith("﻿דירוג,"));
  assert.equal(csv.split("\r\n").length, 1 + r.suggestions.length + r.nearMisses.length);
});

// ---------------------------------------------------------------- real data (Derech Egged)
const SLUG = "derech-egged", DAY = "2026-11-10";
const real = L.keyFile(SLUG) && L.listDays(SLUG).includes(DAY);
const osrm = (() => { // the earlier analysis' OSRM results (data/osrm_cache.json, outside the repo) as a stand-in for road_cache
  const f = path.join(__dirname, "..", "..", "..", "data", "osrm_cache.json");
  if (!fs.existsSync(f)) return null;
  const m = new Map();
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(f, "utf8")))) {
    const [a, b] = k.split(";").map(s => s.split(",").map(Number));
    m.set(E.roadKey(a, b), { km: v[0], min: v[1] });
  }
  return (a, b) => m.get(E.roadKey(a, b)) || null;
})();

test("Derech Egged 10.11: vehicles 23404402 & 23405202 (the report example)", { skip: !real && "no local data key / day file" }, () => {
  const days = L.listDays(SLUG);
  const others = days.filter(d => d !== DAY).map(d => L.loadDay(SLUG, d));
  const r = E.run({ day: L.loadDay(SLUG, DAY), others, ruleset: {}, road: osrm || undefined,
    only: { A: "23404402", B: "23405202", ka: 2, kb: 1, ja: 4, jb: 3 } });
  const ev = r.explained;
  assert.equal(ev.ok, true, JSON.stringify(ev.failed));
  // Two data generations: stop coordinates (the report: ~6.3 road km, margins 56–144) and actual GPS endpoints
  // (continuity-fix: the bus ends a few hundred metres from the stop, times shift by minutes -> ~5.1 km, margins 32–116).
  const gps = L.loadDay(SLUG, DAY).vehicles.some(v => v.items.some(i => i.kind === "trip" && i.a));
  const m = ev.junctions.map(j => j.margin);
  if (!gps) {
    assert.ok(ev.saving_km >= 6.0 && ev.saving_km <= 6.8, "saving " + ev.saving_km);
    assert.deepEqual(m.slice(0, 2), [56, 144]);
    assert.ok(Math.min(...m) >= 56, "margins " + m);
  } else {
    assert.ok(ev.saving_km >= 4.6 && ev.saving_km <= 6.8, "saving " + ev.saving_km);
    assert.ok(Math.abs(m[0] - 59) <= 3 && Math.abs(m[1] - 116) <= 3, "margins " + m);
    assert.ok(Math.min(...m) >= 25, "margins " + m);
  }
  assert.ok(Math.max(...ev.junctions.map(j => j.addedWait)) <= 20);
  assert.equal(ev.stability.hits, 7);
  assert.equal(ev.stability.n, 8);
  // A takes B's 13:00 (400) and 16:00 (401); B takes A's 13:20 (422) and 16:00 (400)
  assert.deepEqual(ev.movedB.map(t => E.fmt(t.sched) + " " + t.line), ["13:00 400", "16:00 401"]);
  assert.deepEqual(ev.movedA.map(t => E.fmt(t.sched) + " " + t.line), ["13:20 422", "16:00 400"]);
  // the report's caveat: 13:00–16:00 as a blocked window rejects it
  const r2 = E.run({ day: L.loadDay(SLUG, DAY), others, ruleset: { operator: { blocked_windows: [{ from: "13:00", to: "16:00" }] } },
    only: { A: "23404402", B: "23405202", ka: 2, kb: 1, ja: 4, jb: 3 } });
  assert.deepEqual(r2.explained.failed, ["blocked_window"]);
});

test("Derech Egged 10.11: full day in < 10 s, deterministic, example pair is suggested", { skip: !real && "no local data key / day file" }, () => {
  const days = L.listDays(SLUG);
  const day = L.loadDay(SLUG, DAY), others = days.filter(d => d !== DAY).map(d => L.loadDay(SLUG, d));
  const t0 = Date.now();
  const r = E.run({ day, others, ruleset: {}, road: osrm || undefined, limits: { suggestions: 1000 } });
  const ms = Date.now() - t0;
  assert.ok(ms < 10000, "took " + ms + " ms");
  assert.ok(r.stats.vehicles > 150);
  const pair = r.suggestions.find(s => s.A === "23404402" && s.B === "23405202");
  assert.ok(pair, "pair suggested");
  assert.ok(pair.saving_km >= 4.6);
  const r2 = E.run({ day, others, ruleset: {}, road: osrm || undefined, limits: { suggestions: 1000 } });
  assert.deepEqual(r2.suggestions.map(s => s.id + ":" + s.saving_km), r.suggestions.map(s => s.id + ":" + s.saving_km));
  console.log(`  real day ${DAY}: ${r.stats.vehicles} vehicles, ${r.suggestions.length} suggestions, ${r.nearMisses.length} near misses, plan ${r.plan.saving_km} km, ${ms} ms, missing road ${r.missingRoad.length}`);
});

test("pair mode explains the best variant of two given vehicles, even when far from passing", () => {
  const r = E.run({ day: synthDay("2026-11-10", { b2Start: 620 }), others: [], ruleset: { operator: { min_saving_km: 50 } }, pair: { A: "B1", B: "A1" } });
  assert.equal(r.suggestions.length, 0);
  assert.equal(r.nearMisses.length, 1);
  assert.ok(r.nearMisses[0].failed.includes("min_saving"));
});
