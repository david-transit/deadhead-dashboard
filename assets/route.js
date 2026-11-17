/* Road distance between two points with OSRM, guarded against bad snapping (one implementation for the browser and the
 * nightly pipeline: pipeline/route.js runs it under node).
 *
 * OSRM snaps each point to the nearest road. At complex terminals that can be the wrong carriageway or a motorway ramp
 * (Arazim terminal -> Route 1: 27.75 km instead of a direct exit to Golda Meir). A route is "suspicious" when:
 *   - it has a U-turn maneuver, or it comes back to a numbered road it already left ("revisit": off the road, a ramp, back on);
 *   - a point snapped more than SNAP_M metres away;
 *   - a terminal point snapped onto a motorway/trunk (a numbered road of 1-2 digits).
 * The plain road/air ratio is NOT used (a long but honest route around a valley is fine).
 * Suspicious routes are recomputed: for each doubtful end, candidate road points (/nearest at the point and on a ring
 * around it, within CAND_M), every combination is routed (plus approaches=curb for the original pair), and the shortest
 * route without a U-turn / revisit wins (score = road km + the distance moved). The result says what was used.
 *
 * Result: {km, min, v, s:[snapA_m, snapB_m], u?:1 (still suspicious), fix?:"near"|"curb", via?:[[lat,lon]|null,[lat,lon]|null],
 *          km0?: km before the fix, ok?:"no_better" (suspicious, nothing better found), why?:[...]}  or null on failure. */
(function (root) {
  "use strict";
  const BASE = "https://router.project-osrm.org", V = 3;
  const SNAP_M = 30, CAND_M = 150, RING_M = [90], GAP_KM = 0.5;
  const rad = Math.PI / 180;
  const hav = (a, b) => { const dp = (b[0] - a[0]) * rad, dl = (b[1] - a[1]) * rad;
    return 2 * 6371 * Math.asin(Math.sqrt(Math.sin(dp / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dl / 2) ** 2)); };
  const refs = s => String(s.ref || "").split(/[;,]/).map(x => x.trim()).filter(Boolean);
  const major = rs => rs.some(r => /^\d{1,2}$/.test(r));

  // what a route looks like: U-turn, revisit, snap distances, motorway at the ends
  function analyze(j) {
    const r = j.routes[0], steps = r.legs.flatMap(l => l.steps || []), why = [];
    if (steps.some(s => s.maneuver && s.maneuver.modifier === "uturn" && s.maneuver.type !== "depart" && s.maneuver.type !== "arrive")) why.push("uturn");
    // points along the route (every intersection), with the distance driven so far and the step's road numbers
    const pts = []; let cum = 0; // d = distance from the start along the intersections (a lower bound of the road distance)
    for (const s of steps) { const rs = refs(s);
      for (const x of s.intersections || []) { const q = [x.location[1], x.location[0]];
        if (pts.length) cum += hav(pts[pts.length - 1].q, q);
        pts.push({ q, d: cum, rs, h: x.bearings && x.out != null ? x.bearings[x.out] : null }); } }
    // revisit = the route comes back to where it already was: a point within 60 m of a point passed >= 2 km earlier
    // (a turnaround on any road), or back on the same numbered road within 400 m of where it drove on it >= 1.5 km earlier.
    // Coming back to the same road number elsewhere (436 in Givat Ze'ev and 436 = Golda Meir) is not a revisit.
    outer: for (let i = 0; i < pts.length; i++) for (let k = 0; k < i; k++) {
      const P = pts[i], Q = pts[k]; if (P.d - Q.d < 1.5) break;
      const m = hav(P.q, Q.q);
      if (m >= 0.4) continue;
      // same line of travel (same or opposite heading): a bridge over its own earlier path is a crossing, not a revisit
      const dh = P.h == null || Q.h == null ? 0 : Math.abs(((P.h - Q.h) % 360 + 540) % 360 - 180);
      if (dh > 30 && dh < 150) continue;
      if ((m < 0.06 && P.d - Q.d >= 2) || (m < 0.4 && P.rs.some(x => Q.rs.includes(x)) && pts.slice(k, i).some(z => !z.rs.some(x => P.rs.includes(x))))) {
        why.push("revisit" + (P.rs[0] ? ":" + P.rs[0] : "")); break outer; }
    }
    const s = j.waypoints.map(w => Math.round(w.distance || 0));
    const near = (i) => { // the road at the start / end of the route (skipping a short unnamed access piece)
      const seq = i ? steps.filter(x => x.maneuver.type !== "arrive").reverse() : steps;
      for (const x of seq.slice(0, 2)) { const rs = refs(x); if (rs.length) return major(rs); if (x.distance > 300) return false; }
      return false; };
    return { km: r.distance / 1000, min: r.duration / 60, s, why, motor: [near(0), near(1)] };
  }
  const bad = x => x.why.length > 0 || x.s.some(m => m > SNAP_M);
  const suspicious = (x, term) => bad(x) || x.motor.some((m, i) => m && term[i]);

  function make(opt) {
    opt = opt || {};
    const fetchJ = opt.fetch || (async u => { // 20 s per request: a hung connection must not stall a nightly build
      const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 20000);
      try { const r = await fetch(u, { signal: ctl.signal }); if (!r.ok && r.status !== 400) throw new Error("osrm " + r.status); return await r.json(); }
      finally { clearTimeout(tm); } });
    const pause = ms => new Promise(r => setTimeout(r, ms));
    const gap = opt.gapMs == null ? 120 : opt.gapMs;
    async function get(u) {
      for (let t = 0; t < 4; t++) {
        try { const j = await fetchJ(u); await pause(gap); if (j && j.code === "Ok") return j; if (j && j.code === "NoRoute") return null; }
        catch (e) { /* retry */ }
        await pause(1500 * (t + 1));
      }
      throw new Error("osrm unavailable");
    }
    const ll = p => `${(+p[1]).toFixed(6)},${(+p[0]).toFixed(6)}`;
    const route = (a, b, curb) => get(`${BASE}/route/v1/driving/${ll(a)};${ll(b)}?overview=false&steps=true${curb ? "&approaches=curb;curb" : ""}`);
    // in the bus's direction of travel: h = [heading at a | null, heading at b | null] (degrees), tol (deg), rad (m)
    const routeH = (a, b, h, tol, rad) => get(`${BASE}/route/v1/driving/${ll(a)};${ll(b)}?overview=false&steps=true&bearings=${
      h.map(x => x == null ? "" : `${Math.round(x)},${tol || 60}`).join(";")}&radiuses=${h.map(x => x == null ? "unlimited" : (rad || 40)).join(";")}`);
    async function candidates(p) { // road points around p (lat,lon): the nearest point of every distinct road first, then the rest
      const all = [], add = w => { const q = [w.location[1], w.location[0]], d = hav(p, q) * 1000;
        if (d <= CAND_M && all.every(o => hav(o.q, q) * 1000 > 10)) all.push({ q, d, n: w.name || "" }); };
      const n = await get(`${BASE}/nearest/v1/driving/${ll(p)}?number=3`); if (n) n.waypoints.forEach(add);
      for (const R of RING_M) for (let k = 0; k < 8; k++) {
        const t = k * Math.PI / 4, q = [p[0] + R * Math.cos(t) / 111320, p[1] + R * Math.sin(t) / (111320 * Math.cos(p[0] * rad))];
        const m = await get(`${BASE}/nearest/v1/driving/${ll(q)}?number=2`); if (m) m.waypoints.forEach(add);
      }
      all.sort((x, y) => x.d - y.d);
      const pick = [], names = new Map();
      for (const c of all) { const k = names.get(c.n) || 0; if (k < 2) { pick.push(c); names.set(c.n, k + 1); } } // <= 2 per road name
      pick.sort((x, y) => x.d - y.d);
      return [[+p[0], +p[1]]].concat(pick.slice(0, 7).map(c => c.q));
    }
    // a: [lat,lon], b: [lat,lon]; o.terminal: [bool,bool] (the end is a bus terminal / stop)
    async function smart(a, b, o) {
      const term = (o && o.terminal) || [true, true];
      if (o && o.h && o.h.some(x => x != null)) { // the bus's heading at a raw GPS end: leave/arrive on its carriageway
        const jh = await routeH(a, b, o.h, o.tol, o.rad);
        if (jh) { const xh = analyze(jh); if (!xh.why.length && !xh.s.some(m => m > SNAP_M)) return { km: Math.round(xh.km * 100) / 100, min: Math.round(xh.min * 10) / 10, v: V, s: xh.s, hd: o.h }; }
      }
      const j0 = await route(a, b); if (!j0) return null;
      const x0 = analyze(j0), out = r => ({ km: Math.round(r.km * 100) / 100, min: Math.round(r.min * 10) / 10, v: V, s: r.s });
      if (!suspicious(x0, term)) return out(x0);
      // which ends to move: a far snap / a motorway at a terminal; a U-turn or revisit can come from either end
      const loop = x0.why.length > 0;
      const need = [0, 1].map(i => loop || x0.s[i] > SNAP_M || (x0.motor[i] && term[i]));
      const CA = need[0] ? await candidates(a) : [[+a[0], +a[1]]], CB = need[1] ? await candidates(b) : [[+b[0], +b[1]]];
      const tries = [{ x: x0, A: CA[0], B: CB[0], fix: null }];
      const c = await route(a, b, true); if (c) tries.push({ x: analyze(c), A: CA[0], B: CB[0], fix: "curb" });
      const tryPair = async (A, B) => { const j = await route(A, B); if (j) tries.push({ x: analyze(j), A, B, fix: "near" }); };
      // one end at a time first (cheap); every combination (nearest 4 x 4) only when that found nothing clean
      for (const A of CA.slice(1)) await tryPair(A, CB[0]);
      for (const B of CB.slice(1)) await tryPair(CA[0], B);
      if (!tries.some(t => !bad(t.x)) && CA.length > 1 && CB.length > 1)
        for (const A of CA.slice(1, 5)) for (const B of CB.slice(1, 5)) await tryPair(A, B);
      for (const t of tries) { t.off = hav(a, t.A) + hav(b, t.B); t.score = t.x.km + t.off; }
      // plausible = no U-turn / revisit; the shortest plausible one wins (a far snap alone does not rule a route out:
      // when the original is still the shortest route without a loop, it stays)
      const okTries = tries.filter(t => !t.x.why.length);
      const best = (okTries.length ? okTries : tries).sort((p, q) => p.score - q.score)[0];
      const r = out({ ...best.x, km: best.x.km + best.off, min: best.x.min + best.off / 25 * 60 });
      if (best.fix) { r.fix = best.fix; r.km0 = Math.round(x0.km * 100) / 100;
        if (best.fix === "near") r.via = [best.A === CA[0] ? null : best.A.map(v => +v.toFixed(6)), best.B === CB[0] ? null : best.B.map(v => +v.toFixed(6))]; }
      if (best.x.why.length) { r.u = 1; r.ok = "no_better"; }       // a loop and nothing better found
      else if (bad(best.x)) r.ok = "shortest";                      // far snap, checked: the shortest route without a loop
      r.why = x0.why.concat(x0.s.some(m => m > SNAP_M) ? ["snap"] : [], x0.motor.some((m, i) => m && term[i]) ? ["motorway"] : []);
      return r;
    }
    // approved bus-only links (via_links): also try OSRM to the link's entry + the link + OSRM from its exit, and keep it
    // when it is shorter than the plain route and neither part has a loop. links: [{id, name, a:[lat,lon], b:[lat,lon], km,
    // both}] already filtered by relevantLinks(). meta.vpc = the link ids considered (a cached result is stale when the set of
    // relevant approved links changes); meta.via = {id, name, km0: plain km, rev: 1 when driven b -> a} when a link is used.
    async function smartLinks(a, b, links, o) {
      const plain = await smart(a, b, o); if (!plain || !links || !links.length) return plain && links && links.length ? { ...plain, vpc: [] } : plain;
      let best = null;
      for (const L of links) for (const [E, X] of L.both ? [[L.a, L.b], [L.b, L.a]] : [[L.a, L.b]]) {
        const r1 = await smart(a, E, { terminal: [((o && o.terminal) || [true, true])[0], false] }),
              r2 = await smart(X, b, { terminal: [false, ((o && o.terminal) || [true, true])[1]] });
        if (!r1 || !r2 || r1.u || r2.u) continue;
        const km = r1.km + +L.km + r2.km, min = r1.min + +L.km / 25 * 60 + r2.min;
        if (km < plain.km - 0.05 && (!best || km < best.km)) best = { km, min, L, s: [r1.s[0], r2.s[1]], rev: E !== L.a };
      }
      const vpc = links.map(linkSig).sort();
      if (!best) return { ...plain, vpc };
      return { km: Math.round(best.km * 100) / 100, min: Math.round(best.min * 10) / 10, v: V, s: best.s, vpc,
               via: { id: best.L.id, name: String(best.L.name).slice(0, 60), km0: plain.km, ...(best.rev ? { rev: 1 } : {}) } };
    }
    return { smart, smartLinks, route, analyze };
  }
  // a saved result that the checker refuses: U-turn / revisit / far snap that nobody looked at
  // links worth trying for a leg a -> b: the link's middle within NEAR_KM of the straight line a-b (legs >= 0.5 km)
  const NEAR_KM = 2;
  function relevantLinks(a, b, links) {
    if (!links || !links.length || !a || !b || hav(a, b) < 0.5) return [];
    const k = Math.cos(((+a[0] + +b[0]) / 2) * rad) * 111.32, xy = p => [(+p[1]) * k, (+p[0]) * 110.57];
    const A = xy(a), B = xy(b), dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
    return links.filter(L => { const m = xy([(+L.a[0] + +L.b[0]) / 2, (+L.a[1] + +L.b[1]) / 2]);
      const t = Math.max(0, Math.min(1, ((m[0] - A[0]) * dx + (m[1] - A[1]) * dy) / L2));
      return Math.hypot(m[0] - A[0] - t * dx, m[1] - A[1] - t * dy) <= NEAR_KM; });
  }
  // a link's signature in meta.vpc: its id, + ":b" when it is used both ways (a one-way result is stale for a link that
  // became two-way: the reverse direction was never tried)
  const linkSig = L => L.both ? L.id + ":b" : L.id;
  const sameIds = (x, y) => JSON.stringify((x || []).slice().sort()) === JSON.stringify((y || []).slice().sort());
  const unresolved = r => !!r && ((r.u || (r.s || []).some(m => m > SNAP_M)) && !r.ok);
  const api = { make, analyze, unresolved, relevantLinks, sameIds, linkSig, V, SNAP_M, hav };
  if (typeof module === "object" && module.exports) module.exports = api; else root.ROUTE = api;
})(typeof self !== "undefined" ? self : this);
