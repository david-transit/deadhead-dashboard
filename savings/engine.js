/* Savings-suggestion engine for the "empty trips" module (pure JS, no DOM).
 * Finds empty-km savings by swapping segments of work between two vehicles of the same operator,
 * without changing the timetable: every trip keeps its time, only the vehicle that runs it changes.
 *
 * Runs in node (tests), in a Web Worker (savings/worker.js) and in the page.
 * Deterministic: same input + same rules + same road cache -> same output, same order.
 *
 * Moves
 *   segment: A runs B's trips kb+1..jb, B runs A's trips ka+1..ja, then each returns to its own block.
 *            Block start and block end of both vehicles stay as today.
 *   tail:    A runs B's trips kb+1..end and B runs A's ka+1..end (only with rules.allow_tail_swap and known depots;
 *            each vehicle still returns to its own depot at night).
 *
 * Rules: operator defaults + per-line overrides. A line override replaces the operator value for that line
 * ("specific wins"); when one check touches several lines, the strictest of their values is used.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SavingsEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const VERSION = "1.0.0";

  // ---------------------------------------------------------------- rules
  // dir: how values combine when one check touches several lines
  //   min  = a lower bound (stricter = larger), max = an upper bound (stricter = smaller),
  //   allow = permission (stricter = false), require = obligation (stricter = true), windows = union
  const RULES_META = [
    { key: "enabled", label: "הקו משתתף בהצעות", type: "bool", dir: "allow", group: "כללי", line: true,
      help: "כבוי = נסיעות הקו לא יועברו בין רכבים." },
    { key: "min_saving_km", label: "חיסכון מינימלי להצעה", unit: "ק\"מ", type: "num", dir: "min", group: "כללי", min: 0, step: 0.5 },
    { key: "min_margin_min", label: "מרווח מינימלי בנקודת החלפה (אחרי זמן הנסיעה הריקה)", unit: "דק'", type: "num", dir: "min", group: "זמנים", min: 0 },
    { key: "max_added_wait_min", label: "המתנה נוספת מקסימלית לעומת היום", unit: "דק'", type: "num", dir: "max", group: "זמנים", min: 0 },
    { key: "max_wait_min", label: "המתנה מקסימלית בנקודת החלפה (ריק = ללא הגבלה)", unit: "דק'", type: "num", dir: "max", group: "זמנים", min: 0, nullable: true },
    { key: "blocked_windows", label: "חלונות זמן חסומים", type: "windows", dir: "windows", group: "זמנים",
      help: "לדוגמה מ־13:00 עד 16:00 (החלפות נהגים ותדלוק)." },
    { key: "blocked_mode", label: "חלון חסום חל על", type: "enum", dir: "enum", group: "זמנים",
      options: [["span", "כל טווח ההחלפה"], ["junction", "רק נקודות ההחלפה"]] },
    { key: "require_dcp", label: "החלפה רק בנקודת החלפת נהגים (מההגדרות)", type: "bool", dir: "require", group: "נהגים" },
    { key: "dcp_radius_m", label: "מרחק מקסימלי מנקודת החלפת נהגים", unit: "מ'", type: "num", dir: "max", group: "נהגים", min: 0, step: 50 },
    { key: "reg168_enabled", label: "תקנה 168(א)(3): הגבלת נהיגה רצופה", type: "bool", dir: "require", group: "נהגים" },
    { key: "reg168_max_drive_min", label: "נהיגה רצופה מקסימלית", unit: "דק'", type: "num", dir: "max", group: "נהגים", min: 0 },
    { key: "reg168_break_min", label: "הפסקה שמאפסת את הנהיגה הרצופה", unit: "דק'", type: "num", dir: "min", group: "נהגים", min: 0 },
    { key: "stability_enabled", label: "יציבות: החיבורים חוזרים בימים אחרים", type: "bool", dir: "require", group: "יציבות" },
    { key: "stability_min_ratio", label: "שיעור חיבורים שחייבים לחזור (0.75 = 6 מתוך 8)", type: "num", dir: "min", group: "יציבות", min: 0, max: 1, step: 0.05 },
    { key: "stability_days", label: "מספר ימים להשוואה (קודם אותו יום בשבוע)", type: "num", dir: "max", group: "יציבות", min: 1, max: 4, operatorOnly: true },
    { key: "allow_cross_branch", label: "מותר בין סניפים", type: "bool", dir: "allow", group: "הרשאות" },
    { key: "allow_cross_class", label: "מותר בין סוגי שירות (עירוני/בינעירוני)", type: "bool", dir: "allow", group: "הרשאות" },
    { key: "allow_tail_swap", label: "מותר להחליף סוף יום (רק כשהחניונים ידועים)", type: "bool", dir: "allow", group: "הרשאות" },
    { key: "distance_source", label: "מקור מרחקים", type: "enum", dir: "enum", group: "מרחקים", operatorOnly: true,
      options: [["road", "כביש (OSRM, מטמון משותף)"], ["estimate", "הערכה בלבד"]] },
    { key: "allow_estimate", label: "מותר להציע לפי הערכה כשאין מרחק כביש (מסומן)", type: "bool", dir: "allow", group: "מרחקים" },
  ];
  const DEFAULT_RULES = {
    enabled: true,
    min_saving_km: 3,
    min_margin_min: 25,
    max_added_wait_min: 30,
    max_wait_min: 180,
    blocked_windows: [],
    blocked_mode: "span",
    require_dcp: false,
    dcp_radius_m: 300,
    reg168_enabled: true,
    reg168_max_drive_min: 240,
    reg168_break_min: 30,
    stability_enabled: true,
    stability_min_ratio: 0.75,
    stability_days: 2,
    allow_cross_branch: false,
    allow_cross_class: false,
    allow_tail_swap: false,
    distance_source: "road",
    allow_estimate: true,
  };
  const META = Object.fromEntries(RULES_META.map(m => [m.key, m]));

  // ruleset = { operator: {...partial}, lines: { "<line>": {...partial} } }
  function normalizeRuleset(rs) {
    rs = rs || {};
    const op = Object.assign({}, DEFAULT_RULES, clean(rs.operator));
    const lines = {};
    for (const [ln, o] of Object.entries(rs.lines || {})) {
      const c = clean(o, true);
      if (Object.keys(c).length) lines[String(ln)] = c;
    }
    return { operator: op, lines };
  }
  function clean(o, forLine) {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) {
      const m = META[k];
      if (!m || (forLine && m.operatorOnly)) continue;
      if (m.type === "num") {
        if (v === null || v === "") { if (m.nullable) out[k] = null; continue; }
        const n = +v; if (Number.isFinite(n)) out[k] = n;
      } else if (m.type === "bool") out[k] = !!v;
      else if (m.type === "windows") out[k] = (Array.isArray(v) ? v : []).map(w => ({ from: hm(w.from), to: hm(w.to) }))
        .filter(w => w.from != null && w.to != null && w.from !== w.to).map(w => ({ from: fmt(w.from), to: fmt(w.to) }));
      else if (m.type === "enum") { if (m.options.some(o2 => o2[0] === v)) out[k] = v; }
    }
    return out;
  }
  // effective value of one rule for a set of lines (strictest across the lines; operator value when no override)
  function ruleFor(R, key, lines) {
    const m = META[key], vals = [];
    const ls = lines && lines.length ? [...new Set(lines.map(String))] : [null];
    for (const l of ls) {
      const o = l != null && R.lines[l];
      vals.push(o && key in o ? o[key] : R.operator[key]);
    }
    switch (m.dir) {
      case "min": return Math.max(...vals.map(v => v == null ? -Infinity : v));
      case "max": { const f = vals.filter(v => v != null); return f.length ? Math.min(...f) : null; }
      case "allow": return vals.every(Boolean);
      case "require": return vals.some(Boolean);
      case "windows": { const all = []; const seen = new Set();
        for (const w of [].concat(...vals)) { const k = w.from + "-" + w.to; if (!seen.has(k)) { seen.add(k); all.push(w); } }
        return all; }
      default: return vals[0];
    }
  }
  // the loosest value across operator + every override (used only to prune the search, never to accept)
  function loosest(R, key) {
    const m = META[key], vals = [R.operator[key], ...Object.values(R.lines).filter(o => key in o).map(o => o[key])];
    if (m.dir === "min") return Math.min(...vals.map(v => v == null ? -Infinity : v));
    if (m.dir === "max") return vals.some(v => v == null) ? Infinity : Math.max(...vals);
    return vals;
  }

  // ---------------------------------------------------------------- geometry / time
  const R_EARTH = 6371.0088;
  function hav(a, b) {
    const t = Math.PI / 180, dLa = (b[0] - a[0]) * t, dLo = (b[1] - a[1]) * t;
    const x = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dLo / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  // same estimate as the dashboard (assets/core.js): air distance x 1.35, 40 km/h
  const estKm = (a, b) => hav(a, b) * 1.35, estMin = km => km / 40 * 60;
  const roadKey = (a, b) => [a[0], a[1], b[0], b[1]].map(x => (+x).toFixed(5)).join(",");
  function hm(s) {
    if (typeof s === "number") return s;
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }
  const fmt = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); };
  const r1 = x => Math.round(x * 10) / 10;
  // a clock window [from,to) on the service-day clock (minutes may exceed 1440 after midnight)
  function windowHits(w, s, e) {
    let f = hm(w.from), t = hm(w.to);
    if (t <= f) t += 1440; // crosses midnight
    for (const off of [-1440, 0, 1440]) if (s < t + off && e > f + off) return true;
    return false;
  }

  // ---------------------------------------------------------------- data adapter
  // getBlocks(day) is the ONLY place that reads day-file fields and vehicle blocks.
  //  - opts.getBlocks(day) (host hook): returns the day with manual block edits applied (continuity-fix: block_edits
  //    table: delete / replace / add / move trips). The engine never reads block_edits itself.
  //  - endpoints: GPS (a_gps/b_gps) when present, else a/b, else day.routes (older files). Change FIELDS or pass opts.fields.
  //  - trip flags: false_start / kind "dup" -> dropped; edited, gps_incomplete, incomplete -> kept and shown.
  //  - a vehicle whose day still has an unresolved data error is skipped: "לא נבדק: שגיאת נתונים" + the reason.
  const FIELDS = {
    from: t => t.a_gps || t.a, to: t => t.b_gps || t.b,
    fromName: t => t.frm || "", toName: t => t.to || "",
    sched: t => t.sched != null ? t.sched : t.start,
    dropped: t => t.kind === "dup" || !!t.false_start,
    edited: t => !!(t.edited || t.edit_id),
    gpsIncomplete: t => !!(t.gps_incomplete || t.incomplete),
    // unresolved data errors (vehicle level / item level); resolved errors carry resolved:true
    vehicleErrors: v => [].concat(v.data_errors || [], v.errors || []).filter(e => e && !e.resolved)
      .map(e => typeof e === "string" ? e : e.why || e.message || e.code || "שגיאה"),
    itemError: it => (it.kind === "error" || (it.error && !it.resolved) || it.unresolved) ? (it.why || it.error || it.message || "שגיאה בפריט") : null,
  };
  const DATA_ERR = "לא נבדק: שגיאת נתונים";
  function getBlocks(day, opts) {
    opts = opts || {};
    if (typeof opts.getBlocks === "function") day = opts.getBlocks(day) || day;
    const F = Object.assign({}, FIELDS, opts.fields || {});
    const out = { day: day.day, dayStart: day.day_start_min != null ? day.day_start_min : 240, vehicles: [], skipped: [] };
    // older day files carry no coordinates on trips: take them from day.routes (line+from+to, then the stop name alone)
    const byRoute = new Map(), byFrom = new Map(), byTo = new Map();
    for (const r of day.routes || []) {
      if (r.o && r.d) byRoute.set(r.line + "|" + r.frm + "|" + r.to, r);
      if (r.o && !byFrom.has(r.frm)) byFrom.set(r.frm, r.o);
      if (r.d && !byTo.has(r.to)) byTo.set(r.to, r.d);
    }
    const viaRoutes = (it, end) => {
      const r = byRoute.get(it.line + "|" + it.frm + "|" + it.to);
      if (r) return end ? r.d : r.o;
      const n = end ? it.to : it.frm;
      return (end ? byTo.get(n) || byFrom.get(n) : byFrom.get(n) || byTo.get(n)) || null;
    };
    const fail = (v, detail) => out.skipped.push({ veh: String(v.veh), why: DATA_ERR, detail, dataError: true });
    for (const v of day.vehicles || []) {
      const errs = F.vehicleErrors(v);
      if (errs.length) { fail(v, errs.join("; ")); continue; }
      const trips = [], gaps = [];
      let pend = null, err = null; // pend = empties after the last trip
      for (const it of v.items || []) {
        const ie = F.itemError(it);
        if (ie) { err = ie; break; }
        if (F.dropped(it)) continue;
        if (it.kind === "trip") {
          const a = F.from(it) || viaRoutes(it, false), b = F.to(it) || viaRoutes(it, true);
          if (!a || !b) { err = `נסיעה בלי קואורדינטות (${fmt(it.start)} קו ${it.line})`; break; }
          if (trips.length) {
            const g = pend || { km: 0, min: 0, n: 0 };
            if (g.noKm) { err = `נסיעה ריקה בלי ק"מ לפני ${fmt(it.start)}`; break; }
            gaps.push(g);
          }
          trips.push({ i: trips.length, start: it.start, end: it.end, sched: F.sched(it), line: String(it.line || ""), lineRef: it.line_ref,
            cls: it.cls || v.cls, a: [+a[0], +a[1]], b: [+b[0], +b[1]], frm: F.fromName(it), to: F.toName(it), km: +it.km || 0,
            auto: !!it.auto, edited: F.edited(it), gpsIncomplete: F.gpsIncomplete(it) });
          pend = null;
        } else if (it.kind === "empty") {
          pend = pend || { km: 0, min: 0, n: 0 };
          pend.km += +it.km || 0; pend.min += +(it.drive_min != null ? it.drive_min : estMin(+it.km || 0)); pend.n++;
          if (it.km == null) pend.noKm = true;
        }
      }
      if (!err) for (let k = 1; k < trips.length; k++) if (trips[k].start < trips[k - 1].end) { err = `נסיעות חופפות (${fmt(trips[k - 1].start)}, ${fmt(trips[k].start)})`; break; }
      if (err) { fail(v, err); continue; }
      if (trips.length < 2) { if (trips.length) out.skipped.push({ veh: String(v.veh), why: "פחות משתי נסיעות" }); continue; }
      out.vehicles.push({ veh: String(v.veh), cls: v.cls || trips[0].cls, trips, gaps });
    }
    out.vehicles.sort((x, y) => x.veh < y.veh ? -1 : x.veh > y.veh ? 1 : 0);
    out.skipped.sort((x, y) => cmpStr(x.veh, y.veh));
    return out;
  }
  const adaptDay = getBlocks; // old name

  // ---------------------------------------------------------------- distances
  // ctx.road(a,b) -> {km,min} | null (shared road_cache, filled by OSRM in the page)
  function makeDist(ctx, R) {
    const memo = new Map(), missing = new Map();
    const useRoad = R.operator.distance_source === "road";
    return {
      get(a, b) {
        const k = roadKey(a, b);
        let r = memo.get(k);
        if (r) return r;
        const air = hav(a, b);
        if (air < 0.05) r = { km: 0, min: 0, src: "same" };
        else {
          const c = useRoad && ctx.road ? ctx.road(a, b) : null;
          if (c && c.km != null) r = { km: +c.km, min: c.min != null ? +c.min : estMin(+c.km), src: "road" };
          else { const km = estKm(a, b); r = { km, min: estMin(km), src: "est" }; }
        }
        memo.set(k, r);
        return r;
      },
      need(a, b) { const r = this.get(a, b); if (r.src === "est" && useRoad) missing.set(roadKey(a, b), [a, b]); },
      // optimistic (never larger than the road distance in practice): used only to prune
      quick(a, b) { const k = roadKey(a, b); const r = memo.get(k); if (r) return r;
        const air = hav(a, b); if (air < 0.05) return { km: 0, min: 0 };
        const c = useRoad && ctx.road ? ctx.road(a, b) : null;
        return c && c.km != null ? { km: +c.km, min: c.min != null ? +c.min : estMin(+c.km) } : { km: air, min: air / 70 * 60 }; },
      missing: () => [...missing.values()],
    };
  }

  // ---------------------------------------------------------------- stability
  const linkKey = (p, q) => p.sched + "|" + p.line + ">" + q.sched + "|" + q.line;
  function linkSet(ad) {
    const s = new Set();
    for (const v of ad.vehicles) for (let k = 0; k + 1 < v.trips.length; k++) s.add(linkKey(v.trips[k], v.trips[k + 1]));
    return s;
  }
  const dayNum = d => Math.round(Date.parse(d + "T12:00:00Z") / 864e5);
  const dayType = d => { const w = new Date(Date.parse(d + "T12:00:00Z")).getUTCDay(); return w === 5 ? "fri" : w === 6 ? "sat" : "wk"; };
  // same weekday first (nearest), then nearest days of the same type (Sun–Thu / Fri / Sat)
  function pickCompareDays(day, candidates, n) {
    const d0 = dayNum(day), w0 = (d0 % 7 + 7) % 7, t0 = dayType(day);
    const c = candidates.filter(d => d !== day);
    const same = c.filter(d => ((dayNum(d) % 7 + 7) % 7) === w0).sort((a, b) => Math.abs(dayNum(a) - d0) - Math.abs(dayNum(b) - d0) || (a < b ? -1 : 1));
    const near = c.filter(d => !same.includes(d) && dayType(d) === t0).sort((a, b) => Math.abs(dayNum(a) - d0) - Math.abs(dayNum(b) - d0) || (a < b ? -1 : 1));
    return same.concat(near).slice(0, n);
  }

  // ---------------------------------------------------------------- core
  /**
   * run(input) -> result
   * input = {
   *   day:      day object (day file JSON) | adapted day
   *   others:   [day objects] candidates for stability (engine picks which)
   *   ruleset:  { operator:{}, lines:{} }
   *   road(a,b) -> {km,min}|null
   *   branchOf(veh) -> string|""      depotOf(veh) -> [lat,lon]|null
   *   dcp: [{name, lat, lon, from, to}]  driver-change points from settings
   *   fields: adapter overrides; limits: {suggestions, nearMisses}
   * }
   */
  function run(input) {
    const t0 = Date.now();
    const R = normalizeRuleset(input.ruleset);
    const isBlocks = d => d.vehicles && d.vehicles[0] && d.vehicles[0].trips;
    const D = isBlocks(input.day) ? input.day : getBlocks(input.day, input);
    const others = (input.others || []).map(o => isBlocks(o) ? o : getBlocks(o, input));
    const cmpDays = pickCompareDays(D.day, others.map(o => o.day), Math.max(1, Math.round(R.operator.stability_days)));
    const cmp = cmpDays.map(d => ({ day: d, links: linkSet(others.find(o => o.day === d)) }));
    const dist = makeDist(input, R);
    const branchOf = input.branchOf || (() => "");
    const depotOf = input.depotOf || (() => null);
    const dcp = (input.dcp || []).filter(p => p && p.lat !== "" && p.lat != null && p.lon !== "" && p.lon != null && Number.isFinite(+p.lat) && Number.isFinite(+p.lon))
      .map(p => ({ name: p.name || "", at: [+p.lat, +p.lon], from: hm(p.from), to: hm(p.to) }));
    const lim = Object.assign({ suggestions: 150, nearMisses: 60 }, input.limits || {});

    // pruning bounds (loosest values across operator + overrides; acceptance always uses the strict per-line value)
    // input.pair = {A,B}: only that pair, no pruning (answers "why not these two?")
    const pairOnly = input.pair ? [String(input.pair.A), String(input.pair.B)] : null;
    const PRUNE_MARGIN = pairOnly ? -Infinity : loosest(R, "min_margin_min") - 20; // 20 min slack: estimate vs road, near misses
    const PRUNE_SAVE = pairOnly ? -Infinity : loosest(R, "min_saving_km") * 0.5;
    const disabledEverywhere = R.operator.enabled === false && !Object.values(R.lines).some(o => o.enabled === true);

    const V = D.vehicles;
    const stats = { vehicles: V.length, pairs: 0, crossings: 0, combos: 0, evaluated: 0 };

    // crossing (A,ka,B,kb): A goes from A[ka] to B[kb+1], B from B[kb] to A[ka+1] (time-feasible under the loosest margin)
    function crossings(A, B) {
      const out = [];
      const ta = A.trips, tb = B.trips;
      for (let ka = 0; ka + 1 < ta.length; ka++) {
        const p = ta[ka], pn = ta[ka + 1];
        for (let kb = 0; kb + 1 < tb.length; kb++) {
          const q = tb[kb], qn = tb[kb + 1];
          if (qn.start <= p.end || pn.start <= q.end) continue;
          if (qn.start - p.end < PRUNE_MARGIN || pn.start - q.end < PRUNE_MARGIN) continue;
          const d1 = dist.quick(p.b, qn.a), d2 = dist.quick(q.b, pn.a);
          if (qn.start - p.end - d1.min < PRUNE_MARGIN || pn.start - q.end - d2.min < PRUNE_MARGIN) continue;
          // optimistic saving of this crossing (old links today minus optimistic new links)
          const sv = A.gaps[ka].km + B.gaps[kb].km - d1.km - d2.km;
          out.push({ ka, kb, sv });
        }
      }
      return out;
    }

    const cands = []; // {A,B,type,ka,kb,ja,jb,osv}
    if (input.only) { // explain one specific move ("why not?"), no pruning
      const o = input.only, A = V.find(v => v.veh === String(o.A)), B = V.find(v => v.veh === String(o.B));
      if (!A || !B) return { error: "רכב לא נמצא ביום הזה", day: D.day };
      const ev = evaluate({ A, B, type: o.type || "segment", ka: o.ka, kb: o.kb, ja: o.ja, jb: o.jb });
      for (const L of ev._links) dist.need(L[0], L[1]); delete ev._links;
      return { version: VERSION, day: D.day, compareDays: cmpDays, ruleset: R, explained: ev, missingRoad: dist.missing() };
    }
    for (let i = 0; i < V.length && !disabledEverywhere; i++) {
      const A = V[i];
      for (let j = i + 1; j < V.length; j++) {
        const B = V[j];
        if (pairOnly && !(pairOnly.includes(A.veh) && pairOnly.includes(B.veh) && A.veh !== B.veh)) continue;
        if (A.trips[A.trips.length - 1].end < B.trips[0].start || B.trips[B.trips.length - 1].end < A.trips[0].start) continue;
        stats.pairs++;
        const C = crossings(A, B);
        if (!C.length) continue;
        stats.crossings += C.length;
        for (let x = 0; x < C.length; x++) {
          const c1 = C[x];
          for (let y = 0; y < C.length; y++) {
            const c2 = C[y];
            if (c2.ka <= c1.ka || c2.kb <= c1.kb) continue;
            stats.combos++;
            if (c1.sv + c2.sv < PRUNE_SAVE) continue;
            cands.push({ A, B, type: "segment", ka: c1.ka, kb: c1.kb, ja: c2.ka, jb: c2.kb, osv: c1.sv + c2.sv });
          }
          // tail swap: a single crossing, both continue on the other's block to the end of the day
          if (R.operator.allow_tail_swap || Object.values(R.lines).some(o => o.allow_tail_swap)) {
            const dA = depotOf(A.veh), dB = depotOf(B.veh);
            if (dA && dB) {
              const la = A.trips[A.trips.length - 1], lb = B.trips[B.trips.length - 1];
              const old = dist.quick(la.b, dA).km + dist.quick(lb.b, dB).km, neu = dist.quick(lb.b, dA).km + dist.quick(la.b, dB).km;
              if (c1.sv + old - neu >= PRUNE_SAVE) cands.push({ A, B, type: "tail", ka: c1.ka, kb: c1.kb, ja: null, jb: null, osv: c1.sv + old - neu });
            }
          }
        }
      }
    }
    // evaluate best optimistic first; deterministic order
    cands.sort((x, y) => y.osv - x.osv || cmpStr(x.A.veh, y.A.veh) || cmpStr(x.B.veh, y.B.veh) || x.ka - y.ka || x.kb - y.kb || (x.ja || 0) - (y.ja || 0) || (x.jb || 0) - (y.jb || 0));

    const bestPass = new Map(), bestMiss = new Map(), passVariants = new Map();
    for (const c of cands) {
      if (disabledEverywhere) break;
      const ev = evaluate(c);
      stats.evaluated++;
      const pk = c.A.veh + "|" + c.B.veh;
      if (ev.ok) {
        passVariants.set(pk, (passVariants.get(pk) || 0) + 1);
        const cur = bestPass.get(pk);
        if (!cur || better(ev, cur)) bestPass.set(pk, ev);
      } else if (pairOnly || (ev.saving_km >= ev.minSave * 0.5 && ev.failed.length <= 2)) {
        const cur = bestMiss.get(pk);
        if (!cur || ev.failed.length < cur.failed.length || (ev.failed.length === cur.failed.length && better(ev, cur))) bestMiss.set(pk, ev);
      }
    }
    const suggestions = [...bestPass.values()].sort(rank).slice(0, lim.suggestions);
    suggestions.forEach((s, i) => { s.rank = i + 1; s.variants = passVariants.get(s.A + "|" + s.B) || 1; });
    // a near miss is only interesting when the pair has no passing suggestion
    const nearMisses = [...bestMiss.values()].filter(m => !bestPass.has(m.A + "|" + m.B))
      .sort((x, y) => x.failed.length - y.failed.length || rank(x, y)).slice(0, lim.nearMisses);
    // non-conflicting set (each vehicle in one suggestion at most), greedy by rank
    const used = new Set(), plan = [];
    for (const s of suggestions) if (!used.has(s.A) && !used.has(s.B)) { used.add(s.A); used.add(s.B); plan.push(s.id); }
    for (const s of suggestions) for (const x of [...suggestions, ...nearMisses]) {
      if (x !== s && (x.A === s.A || x.A === s.B || x.B === s.A || x.B === s.B)) (s.conflicts = s.conflicts || []).push(x.id);
    }
    for (const s of [...suggestions, ...nearMisses]) { for (const L of s._links) dist.need(L[0], L[1]); delete s._links; }
    return {
      version: VERSION, day: D.day, compareDays: cmpDays, ruleset: R,
      suggestions, nearMisses,
      plan: { ids: plan, saving_km: r1(suggestions.filter(s => plan.includes(s.id)).reduce((t, s) => t + s.saving_km, 0)) },
      missingRoad: dist.missing(), skipped: D.skipped || [],
      stats: Object.assign(stats, { candidates: cands.length, ms: Date.now() - t0 }),
    };

    // ---------------------------------------------------------- evaluate one candidate
    function evaluate(c) {
      const { A, B, type, ka, kb } = c;
      const ta = A.trips, tb = B.trips, seg = type === "segment";
      const ja = seg ? c.ja : ta.length - 1, jb = seg ? c.jb : tb.length - 1;
      const movedA = ta.slice(ka + 1, ja + 1), movedB = tb.slice(kb + 1, jb + 1); // A's trips now run by B, B's by A
      const movedLines = [...movedA, ...movedB].map(t => t.line);
      const rulesUsed = [];
      const res = (id, ok, detail, extra) => { rulesUsed.push(Object.assign({ id, ok, label: RULE_LABEL[id], detail }, extra || {})); return ok; };
      // junctions: [vehicle, arriving trip, departing trip, today's next trip, today's gap]
      const J = [
        { veh: A.veh, who: "A", p: ta[ka], q: tb[kb + 1], tq: ta[ka + 1], tg: A.gaps[ka] },
        { veh: B.veh, who: "B", p: tb[kb], q: ta[ka + 1], tq: tb[kb + 1], tg: B.gaps[kb] },
      ];
      if (seg) J.push(
        { veh: A.veh, who: "A", p: tb[jb], q: ta[ja + 1], tq: null, tg: A.gaps[ja], todayP: ta[ja] },
        { veh: B.veh, who: "B", p: ta[ja], q: tb[jb + 1], tq: null, tg: B.gaps[jb], todayP: tb[jb] });
      const links = [];
      let todayKm = 0, newKm = 0, estUsed = false;
      for (const j of J) {
        const d = dist.get(j.p.b, j.q.a);
        links.push([j.p.b, j.q.a]);
        if (d.src === "est") estUsed = true;
        const tp = j.todayP || j.p, tqq = j.tq || j.q;     // today's link for this vehicle at this point
        const waitToday = tqq.start - tp.end;
        const waitNew = j.q.start - j.p.end;
        Object.assign(j, { km: d.km, min: d.min, src: d.src, arrive: j.p.end, depart: j.q.start,
          margin: j.q.start - j.p.end - d.min, waitNew, waitToday, addedWait: waitNew - waitToday,
          todayKm: j.tg.km, place: j.p.to || j.q.frm, placeTo: j.q.frm, lines: [j.p.line, j.q.line] });
        todayKm += j.tg.km; newKm += d.km;
      }
      let depot = null;
      if (!seg) {
        const dA = depotOf(A.veh), dB = depotOf(B.veh), la = ta[ta.length - 1], lb = tb[tb.length - 1];
        const o1 = dist.get(la.b, dA), o2 = dist.get(lb.b, dB), n1 = dist.get(lb.b, dA), n2 = dist.get(la.b, dB);
        for (const L of [[la.b, dA], [lb.b, dB], [lb.b, dA], [la.b, dB]]) links.push(L);
        if ([o1, o2, n1, n2].some(x => x.src === "est")) estUsed = true;
        depot = { todayKm: o1.km + o2.km, newKm: n1.km + n2.km };
        todayKm += depot.todayKm; newKm += depot.newKm;
      }
      const saving = todayKm - newKm;
      const failed = [];
      const chk = (id, ok, detail, extra) => { if (!res(id, ok, detail, extra)) failed.push(id); };

      // participation (line switched off)
      const offLines = [...new Set(movedLines)].filter(l => !ruleFor(R, "enabled", [l]));
      chk("enabled", !offLines.length, offLines.length ? "קווים מוחרגים: " + offLines.join(", ") : "כל הקווים משתתפים");
      // class / branch
      const clsA = A.cls || "", clsB = B.cls || "";
      if (clsA !== clsB) chk("cross_class", ruleFor(R, "allow_cross_class", movedLines), `${clsA || "?"} / ${clsB || "?"}`);
      else res("cross_class", true, clsA || "אותו סוג");
      const brA = branchOf(A.veh) || "", brB = branchOf(B.veh) || "";
      if (brA && brB && brA !== brB) chk("cross_branch", ruleFor(R, "allow_cross_branch", movedLines), `${brA} / ${brB}`);
      else res("cross_branch", true, brA && brB ? brA : "סניף לא ידוע לאחד הרכבים", { warn: !(brA && brB) });
      if (!seg) chk("tail_swap", ruleFor(R, "allow_tail_swap", movedLines), "החלפת סוף יום");
      // junction rules
      let minMargin = Infinity;
      for (const j of J) {
        const mm = ruleFor(R, "min_margin_min", j.lines), aw = ruleFor(R, "max_added_wait_min", j.lines), mw = ruleFor(R, "max_wait_min", j.lines);
        j.rule = { min_margin_min: mm, max_added_wait_min: aw, max_wait_min: mw };
        j.ok = { margin: j.margin >= mm, added: j.addedWait <= aw, wait: mw == null || j.waitNew <= mw };
        minMargin = Math.min(minMargin, j.margin);
      }
      const jm = J.filter(j => !j.ok.margin);
      chk("margin", !jm.length, jm.length ? jm.map(j => `${fmt(j.arrive)}: ${Math.round(j.margin)} < ${j.rule.min_margin_min}`).join("; ") : `מינימום ${Math.round(minMargin)} דק'`);
      const ja2 = J.filter(j => !j.ok.added);
      chk("added_wait", !ja2.length, ja2.length ? ja2.map(j => `${fmt(j.arrive)}: +${j.addedWait} > ${j.rule.max_added_wait_min}`).join("; ") : `מקסימום ${fmtSigned(Math.max(...J.map(j => j.addedWait)))} דק'`);
      const jw = J.filter(j => !j.ok.wait);
      chk("max_wait", !jw.length, jw.length ? jw.map(j => `${fmt(j.arrive)}: ${j.waitNew} > ${j.rule.max_wait_min}`).join("; ") : `מקסימום ${Math.max(...J.map(j => j.waitNew))} דק'`);
      // blocked windows
      const span = [Math.min(...J.map(j => j.arrive)), seg ? Math.max(...J.map(j => j.depart)) : Math.max(ta[ta.length - 1].end, tb[tb.length - 1].end)];
      const mode = ruleFor(R, "blocked_mode", movedLines);
      const bw = [];
      if (mode === "junction") { for (const j of J) for (const w of ruleFor(R, "blocked_windows", j.lines)) if (windowHits(w, j.arrive, j.depart)) bw.push(w); }
      else for (const w of ruleFor(R, "blocked_windows", movedLines)) if (windowHits(w, span[0], span[1])) bw.push(w);
      chk("blocked_window", !bw.length, bw.length ? "חופף ל־" + [...new Set(bw.map(w => w.from + "–" + w.to))].join(", ") : `טווח ${fmt(span[0])}–${fmt(span[1])}`);
      // driver-change points
      const dcpLines = [].concat(...J.map(j => j.lines));
      if (ruleFor(R, "require_dcp", dcpLines)) {
        const bad = [];
        for (const j of J) {
          const rad = ruleFor(R, "dcp_radius_m", j.lines) / 1000;
          const hit = dcp.find(p => hav(p.at, j.p.b) <= rad && hav(p.at, j.q.a) <= rad &&
            (p.from == null || p.to == null || windowHits({ from: p.from, to: p.to }, j.arrive, j.depart)));
          j.dcp = hit ? hit.name : null;
          if (!hit) bad.push(fmt(j.arrive) + " " + (j.place || ""));
        }
        chk("dcp", !bad.length, !dcp.length ? "אין נקודות החלפת נהגים בהגדרות" : bad.length ? "לא בנקודה: " + bad.join("; ") : "כל הנקודות מוגדרות");
      } else res("dcp", true, "לא נדרש (הנחה: הנהג נשאר עם האוטובוס)", { off: true });
      // reg. 168(a)(3): continuous driving on both new days
      const allLines = [...new Set([...ta, ...tb].map(t => t.line))];
      if (ruleFor(R, "reg168_enabled", allLines)) {
        const maxD = ruleFor(R, "reg168_max_drive_min", allLines), brk = ruleFor(R, "reg168_break_min", allLines);
        const linkMin = new Map(J.map(j => [j.p, j]));
        const newA = seg ? ta.slice(0, ka + 1).concat(tb.slice(kb + 1, jb + 1), ta.slice(ja + 1)) : ta.slice(0, ka + 1).concat(tb.slice(kb + 1));
        const newB = seg ? tb.slice(0, kb + 1).concat(ta.slice(ka + 1, ja + 1), tb.slice(jb + 1)) : tb.slice(0, kb + 1).concat(ta.slice(ka + 1));
        const gapMin = (owner, p, q) => { const j = linkMin.get(p); if (j && j.q === q) return j.min;
          const v = owner.find(x => x.trips[p.i] === p); return v && v.trips[p.i + 1] === q ? v.gaps[p.i].min : dist.get(p.b, q.a).min; };
        const cdA = contDrive(newA, (p, q) => gapMin([A, B], p, q), brk), cdB = contDrive(newB, (p, q) => gapMin([A, B], p, q), brk);
        const worst = Math.max(cdA, cdB);
        chk("reg168", worst <= maxD, `נהיגה רצופה מרבית ${Math.round(worst)} דק' (מותר ${maxD}, הפסקה ${brk})`, { value: Math.round(worst) });
      } else res("reg168", true, "כבוי בהגדרות", { off: true, warn: true });
      // stability: the links that the swap breaks must repeat on the compared days
      const oldLinks = [[ta[ka], ta[ka + 1]], [tb[kb], tb[kb + 1]]];
      if (seg) oldLinks.push([ta[ja], ta[ja + 1]], [tb[jb], tb[jb + 1]]);
      const stabLines = [].concat(...oldLinks.map(([p, q]) => [p.line, q.line]));
      let stab = null;
      if (ruleFor(R, "stability_enabled", stabLines)) {
        if (!cmp.length) res("stability", true, "לא נבדקה: אין ימים להשוואה", { warn: true, unverified: true });
        else {
          let hits = 0; const miss = [];
          for (const c2 of cmp) for (const [p, q] of oldLinks) {
            if (c2.links.has(linkKey(p, q))) hits++; else miss.push(`${c2.day}: ${fmt(p.sched)} ${p.line} ← ${fmt(q.sched)} ${q.line}`);
          }
          const n = oldLinks.length * cmp.length, ratio = ruleFor(R, "stability_min_ratio", stabLines), need = Math.ceil(ratio * n - 1e-9);
          stab = { hits, n, need, days: cmp.map(x => x.day), missing: miss };
          chk("stability", hits >= need, `${hits} מתוך ${n} חיבורים חוזרים (נדרש ${need})`, { value: hits });
        }
      } else res("stability", true, "כבוי בהגדרות", { off: true });
      // distance source
      if (estUsed) chk("estimate", ruleFor(R, "allow_estimate", movedLines), "חלק מהמרחקים הם הערכה (אין עדיין מרחק כביש)", { warn: true });
      // data quality: manually edited trips / incomplete GPS among the trips this move touches (shown, not blocking)
      const touched = [...movedA, ...movedB, ...J.map(j => j.p), ...J.map(j => j.q)];
      const ed = [...new Set(touched.filter(t => t.edited))], gi = [...new Set(touched.filter(t => t.gpsIncomplete))];
      if (ed.length || gi.length) res("data_quality", true, [ed.length ? `${ed.length} נסיעות שנערכו ידנית` : "", gi.length ? `${gi.length} נסיעות עם GPS חלקי` : ""].filter(Boolean).join(" · "), { warn: true });
      // minimum saving (last: everything above explains "why not" even when the saving is small)
      const minSave = ruleFor(R, "min_saving_km", movedLines);
      chk("min_saving", saving >= minSave - 1e-9, `${r1(saving)} ק"מ (נדרש ${minSave})`);

      const id = `${type[0]}:${A.veh}:${B.veh}:${ka}:${kb}:${seg ? ja + ":" + jb : "end"}`;
      return {
        id, type, A: A.veh, B: B.veh, clsA, clsB, branchA: brA, branchB: brB, ka, kb, ja: seg ? ja : null, jb: seg ? jb : null,
        ok: failed.length === 0, failed, minSave,
        saving_km: r1(saving), today_km: r1(todayKm), proposed_km: r1(newKm),
        distance: estUsed ? "estimate" : "road",
        min_margin: Math.round(minMargin), span: [span[0], span[1]], spanText: fmt(span[0]) + "–" + fmt(span[1]),
        junctions: J.map(j => ({ veh: j.veh, who: j.who, place: j.place, placeTo: j.placeTo, arrive: j.arrive, depart: j.depart,
          arriveText: fmt(j.arrive), departText: fmt(j.depart), fromLine: j.p.line, toLine: j.q.line,
          km: r1(j.km), min: Math.round(j.min), src: j.src, todayKm: r1(j.todayKm), margin: Math.round(j.margin),
          waitNew: j.waitNew, waitToday: j.waitToday, addedWait: j.addedWait, rule: j.rule, ok: j.ok, dcp: j.dcp })),
        depot: depot && { todayKm: r1(depot.todayKm), newKm: r1(depot.newKm) },
        stability: stab, rules: rulesUsed,
        movedA: movedA.map(tripOut), movedB: movedB.map(tripOut),
        timelines: { A: { today: ta.map(tripOut), proposed: (seg ? ta.slice(0, ka + 1).concat(tb.slice(kb + 1, jb + 1), ta.slice(ja + 1)) : ta.slice(0, ka + 1).concat(tb.slice(kb + 1))).map(tripOut) },
                     B: { today: tb.map(tripOut), proposed: (seg ? tb.slice(0, kb + 1).concat(ta.slice(ka + 1, ja + 1), tb.slice(jb + 1)) : tb.slice(0, kb + 1).concat(ta.slice(ka + 1))).map(tripOut) } },
        _links: links,
      };
    }
    function tripOut(t) { return { start: t.start, end: t.end, sched: t.sched, line: t.line, frm: t.frm, to: t.to, km: t.km, edited: t.edited, gpsIncomplete: t.gpsIncomplete }; }
  }
  function contDrive(trips, gapMin, brk) {
    let acc = 0, worst = 0;
    for (let k = 0; k < trips.length; k++) {
      if (k) {
        const g = gapMin(trips[k - 1], trips[k]), idle = trips[k].start - trips[k - 1].end - g;
        if (idle >= brk) acc = 0; else acc += g;
      }
      acc += trips[k].end - trips[k].start;
      worst = Math.max(worst, acc);
    }
    return worst;
  }
  const RULE_LABEL = {
    enabled: "קו משתתף", cross_class: "אותו סוג שירות", cross_branch: "אותו סניף", tail_swap: "החלפת סוף יום",
    margin: "מרווח בנקודות ההחלפה", added_wait: "המתנה נוספת", max_wait: "המתנה מקסימלית", blocked_window: "חלונות חסומים",
    dcp: "נקודת החלפת נהגים", reg168: "תקנה 168(א)(3)", stability: "יציבות בין ימים", estimate: "מרחק כביש",
    min_saving: "חיסכון מינימלי", data_quality: "איכות נתונים",
  };
  const fmtSigned = n => (n > 0 ? "+" : "") + n;
  const cmpStr = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  function better(x, y) { return rank(x, y) < 0; }
  // saving desc, road before estimate, fewer moved trips (switching cost), larger min margin, stability, id
  const moved = s => s.movedA.length + s.movedB.length;
  function rank(x, y) {
    return (y.saving_km - x.saving_km) || ((x.distance === "road" ? 0 : 1) - (y.distance === "road" ? 0 : 1)) || (moved(x) - moved(y)) ||
      (y.min_margin - x.min_margin) || (((y.stability || {}).hits || 0) - ((x.stability || {}).hits || 0)) || cmpStr(x.id, y.id);
  }

  // ---------------------------------------------------------------- CSV
  function toCSV(result) {
    const q = s => { s = s == null ? "" : String(s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const head = ["דירוג", "סטטוס", "סוג", "רכב א'", "רכב ב'", "טווח", "ריק היום (ק\"מ)", "ריק בהצעה (ק\"מ)", "חיסכון (ק\"מ)", "מקור מרחק",
      "מרווח מינימלי (דק')", "יציבות", "נקודות החלפה", "כללים שנכשלו"];
    const rows = [head];
    const add = (s, st) => rows.push([s.rank || "", st, s.type === "segment" ? "קטע" : "סוף יום", s.A, s.B, s.spanText, s.today_km, s.proposed_km, s.saving_km,
      s.distance === "road" ? "כביש" : "הערכה", s.min_margin, s.stability ? `${s.stability.hits}/${s.stability.n}` : "לא נבדקה",
      s.junctions.map(j => `${j.veh} ${j.arriveText}→${j.departText} ${j.place} ${j.km}ק"מ מרווח ${j.margin}`).join(" | "),
      s.failed.map(f => RULE_LABEL[f]).join(", ")]);
    result.suggestions.forEach(s => add(s, "מוצע"));
    result.nearMisses.forEach(s => add(s, "נפסל"));
    return "﻿" + rows.map(r => r.map(q).join(",")).join("\r\n");
  }

  return { VERSION, RULES_META, DEFAULT_RULES, RULE_LABEL, normalizeRuleset, ruleFor, getBlocks, adaptDay, DATA_ERR, run, toCSV, pickCompareDays,
    hav, estKm, estMin, roadKey, fmt, hm, contDrive, FIELDS };
});
