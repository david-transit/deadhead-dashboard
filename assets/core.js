// yalla-sa deadhead: the one model of a vehicle-day. Used by index.html (browser) and by audit/model_check.js (Node),
// so the checker verifies exactly what the dashboard shows.
//
// Night = one entity per (vehicle, night before day N). P = the last day before N on which the vehicle ran (also across
// idle days, up to LOOKBACK days). The choice is stored on N (overnight_override.day = N) and both P and N read it.
// Every leg of a night is counted once, on the service day in which it starts (before N's day start -> P, else N):
//   stay  (default): P's last stop -> N's first trip, driven in the morning, counted on N ("יציאה ריקה לתחילת היום")
//   depot: P's last stop -> depot right after P's last trip (on P) + depot -> N's first trip (on N)
//   rein : P's last stop -> line start (empty) + the line (reinforcement) [+ line end -> depot (empty)] + -> N's first trip (empty)
// No previous day in the data (range start / unbuilt day in between): "לילה פתוח" (nothing counted, flagged).
// Last built day: "לילה פתוח" for the night after it (recomputed when the next day is built).
(function (root) {
  "use strict";
  const LOOKBACK = 14;
  const hav = (a, b) => { const R = 6371, r = x => x * Math.PI / 180, dp = r(b[0] - a[0]), dl = r(b[1] - a[1]);
    return 2 * R * Math.asin(Math.sqrt(Math.sin(dp / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dl / 2) ** 2)); };
  const estKm = (a, b) => hav(a, b) * 1.35, estMin = km => km / 40 * 60;
  const roadKey = (a, b) => [a[0], a[1], b[0], b[1]].map(x => (+x).toFixed(5)).join(",");
  const dayNum = d => Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5);
  const dayStr = n => new Date(n * 864e5).toISOString().slice(0, 10);
  const addDays = (d, k) => dayStr(dayNum(d) + k);
  const AREA = { "בני ברק": ["בני ברק", "פתח תקווה", "רמת גן", "תל אביב יפו", "גבעתיים", "ראש העין", "חולון", "בת ים", "קרית אונו", "אור יהודה"],
    "ירושלים": ["ירושלים", "מבשרת ציון", "גבעת זאב", "מטה יהודה", "בית חורון", "מעלה אדומים"] };
  const OVMODES = [["stay", "יצא למחרת מהמקום שבו סיים"], ["depot", "חזר לחניון בלילה"], ["rein", "נסיעת תגבור בלילה"]];
  const LEGNAME = { over: "יציאה ריקה לתחילת היום", out: "יציאה מחניון", in: "חזרה לחניון בלילה", r_to: "ריק לתחילת קו התגבור",
    rein: "תגבור לילה", r_dep: "ריק מסוף קו התגבור לחניון", r_from: "ריק לנסיעה הראשונה" };
  const EMPTY_NIGHT = new Set(["over", "out", "in", "r_to", "r_dep", "r_from"]);
  // ends index entry: [fStart, fLat, fLon, fCity, fPlace, lEnd, lLat, lLon, lCity, lPlace, lLine, cls]

  function Model(ctx) {
    // ctx: {days, dayStartMin, ends:{day:{veh:entry}}, S:{depots, vehicles, defaults}, OVN:{"N|veh":{mode,detail}},
    //       REIN:{"D|veh|next_sched":row}, AUTOR:{"D|veh|sched":status}, road:(a,b)=>{km,min}|null}
    const M = {};
    const built = new Set(ctx.days), first = ctx.days[0], last = ctx.days[ctx.days.length - 1];
    const S0 = ctx.dayStartMin ?? 240;
    const abs = (d, m) => dayNum(d) * 1440 + m, rel = (d, t) => t - dayNum(d) * 1440;
    const E = (d, veh) => (ctx.ends[d] || {})[veh] || null;
    const vset = veh => (ctx.S.vehicles || {})[veh] || {};
    const depotById = id => (ctx.S.depots || []).find(d => d.id === id) || null;
    const hasLoc = d => d && d.lat != null && d.lon != null && d.lat !== "" && d.lon !== "" && isFinite(parseFloat(d.lat)) && isFinite(parseFloat(d.lon));
    function depotFor(veh, which, city) {
      const id = (which === "in" && vset(veh).depot_end) || vset(veh).depot;
      if (id) return depotById(id);
      return (ctx.S.depots || []).find(d => (d.cities || "").split(",").map(s => s.trim()).filter(Boolean).includes(city)) || null;
    }
    function leg(kind, a, b, x) {
      if (!a || !b) return { kind, km: null, min: null, road: false, a, b, ...x };
      if (hav(a, b) < 0.05) return { kind, a, b, km: 0, min: 0, road: true, ...x };
      const r = ctx.road && ctx.road(a, b), km = r ? r.km : estKm(a, b);
      return { kind, a, b, km, min: r ? r.min : estMin(km), road: !!r, ...x };
    }
    // where the vehicle was before day D (prev) / after day D (next)
    function prevActive(veh, D) {
      for (let k = 1; k <= LOOKBACK; k++) {
        const d = addDays(D, -k);
        if (d < first || !built.has(d)) return { open: true, reason: d < first ? "start" : "missing", day: d };
        if (E(d, veh)) return { day: d, e: E(d, veh), idle: k - 1 };
      }
      return { none: true };
    }
    function nextActive(veh, D) {
      for (let k = 1; k <= LOOKBACK; k++) {
        const d = addDays(D, k);
        if (d > last || !built.has(d)) return { open: true, reason: d > last ? "end" : "missing", day: d };
        if (E(d, veh)) return { day: d, e: E(d, veh), idle: k - 1 };
      }
      return { none: true };
    }
    const ovOf = (N, veh) => ctx.OVN[N + "|" + veh] || null;
    // all legs of the night before day N (absolute minutes), each with day = the service day that counts it
    function night(veh, N) {
      const e = E(N, veh); if (!e) return null;
      const p = prevActive(veh, N), ov = ovOf(N, veh), mode = ov ? ov.mode : "stay", det = (ov && ov.detail) || {};
      const F = [e[1], e[2]], tF = abs(N, e[0]), nPlace = e[4];
      const res = { key: N, veh, p, mode, ov, legs: [], flags: [] };
      const cut = abs(N, S0);
      // morning legs (over / out / r_from) belong to N, the return to the depot to P; the overnight reinforcement legs to
      // the service day in which they start (e.g. 26:00 = P, 05:10 = N)
      const put = l => { l.day = l.kind === "in" ? p.day : ["over", "out", "r_from"].includes(l.kind) ? N : (l.start < cut ? p.day : N);
        if (!l.day) l.day = N; res.legs.push(l); return l; };
      if (p.open) { res.flags.push(p.reason === "start" ? "open_start" : "open_missing"); return res; }
      if (p.none) { // idle for LOOKBACK days: assume it left its depot in the morning
        const d = depotFor(veh, "out", e[3]);
        const l = !d || !hasLoc(d) ? { kind: "out", km: null, missing: d ? "depot_loc" : "depot", depot: d && d.name } :
          leg("out", [+d.lat, +d.lon], F, { depot: d.name, frm: d.name, to: nPlace });
        if (l.km != null) { l.end = tF; l.start = tF - l.min; } else { l.start = l.end = tF; }
        put(l); res.flags.push("long_idle"); return res;
      }
      const pe = p.e, A = [pe[6], pe[7]], tA = abs(p.day, pe[5]), aPlace = pe[9];
      if (mode === "depot") {
        // the depot it returns to = its depot from the vehicle settings (end-of-day depot if set), else the depot of the city
        // where it starts in the morning, else of the city where it ended; a depot saved with the choice wins (settings
        // changed later do not rewrite past nights)
        const home = depotFor(veh, "out", e[3]) || depotFor(veh, "out", pe[8]);
        const di = (det.depot_in && depotById(det.depot_in)) || (vset(veh).depot_end || vset(veh).depot ? depotFor(veh, "in") : home);
        const dout = (det.depot_out && depotById(det.depot_out)) || home;
        const li = !di || !hasLoc(di) ? { kind: "in", km: null, missing: di ? "depot_loc" : "depot", depot: di && di.name, frm: aPlace } :
          leg("in", A, [+di.lat, +di.lon], { depot: di.name, frm: aPlace, to: di.name });
        li.start = tA; li.end = tA + (li.min || 0); put(li);
        const lo = !dout || !hasLoc(dout) ? { kind: "out", km: null, missing: dout ? "depot_loc" : "depot", depot: dout && dout.name, to: nPlace } :
          leg("out", [+dout.lat, +dout.lon], F, { depot: dout.name, frm: dout.name, to: nPlace });
        lo.end = tF; lo.start = tF - (lo.min || 0); put(lo);
        if (li.km != null && lo.km != null && li.end > lo.start) res.flags.push("tight");
      } else if (mode === "rein" && det.line && det.o && det.d && det.start != null) {
        const t0 = det.start, O = det.o, Dd = det.d, dur = +det.dur || 0;
        const l1 = leg("r_to", A, O, { frm: aPlace, to: det.frm }); l1.end = t0; l1.start = t0 - l1.min; put(l1);
        const l2 = { kind: "rein", a: O, b: Dd, km: +det.rein_km || 0, min: dur, road: true, start: t0, end: t0 + dur, line: det.line, frm: det.frm, to: det.to }; put(l2);
        let tail = Dd, tailPlace = det.to, after = l2.end;
        if (det.depot_wait) {
          const dw = depotById(det.depot_wait) || depotFor(veh, "in", det.to_city);
          const l3 = !dw || !hasLoc(dw) ? { kind: "r_dep", km: null, missing: dw ? "depot_loc" : "depot", depot: dw && dw.name, frm: det.to } :
            leg("r_dep", Dd, [+dw.lat, +dw.lon], { depot: dw.name, frm: det.to, to: dw.name });
          l3.start = after; l3.end = after + (l3.min || 0); put(l3);
          after = l3.end; tail = dw && hasLoc(dw) ? [+dw.lat, +dw.lon] : null; tailPlace = dw ? dw.name : "";
        }
        const l4 = tail ? leg("r_from", tail, F, { frm: tailPlace, to: nPlace }) : { kind: "r_from", km: null, missing: "depot", to: nPlace };
        l4.end = tF; l4.start = tF - (l4.min || 0); put(l4);
        if (l1.start < tA || l4.start < after) res.flags.push("tight");
      } else {
        if (mode === "rein") res.flags.push("rein_incomplete"); // old/partial choice: shown, counted as the default move
        const l = leg("over", A, F, { frm: aPlace, to: nPlace }); l.end = tF; l.start = tF - l.min; put(l);
        if (l.start < tA) res.flags.push("tight");
      }
      if (p.idle) res.flags.push("idle_days");
      return res;
    }
    // ---- branch: confirmed value from settings; otherwise the area where the vehicle starts/ends most often over all loaded
    // days (one value per vehicle, so it never changes between the two days of a night) ----
    const areaOf = c => { for (const k in AREA) if (AREA[k].includes(c)) return k; return ""; };
    const BR = new Map();
    function autoBranch(veh) {
      if (BR.has(veh)) return BR.get(veh);
      const cnt = {};
      for (const d in ctx.ends) { const e = ctx.ends[d][veh]; if (!e) continue;
        for (const c of [e[3], e[8]]) { const a = areaOf(c); if (a) cnt[a] = (cnt[a] || 0) + 1; } }
      const best = Object.entries(cnt).sort((x, y) => y[1] - x[1]);
      const r = best.length && (best.length === 1 || best[0][1] > best[1][1]) ? best[0][0] : "";
      BR.set(veh, r); return r;
    }
    function branchOf(veh, D) { const x = vset(veh); return x.branch_confirmed ? { b: x.branch || "", auto: false } : { b: autoBranch(veh, D), auto: true }; }
    // ---- one vehicle-day ----
    const autoSt = (D, veh, i) => ctx.AUTOR[D + "|" + veh + "|" + i.sched] || "pending";
    const reinOf = (D, veh, i) => i.next_sched != null ? ctx.REIN[D + "|" + veh + "|" + i.next_sched] || null : null;
    function vehicleDay(v, D) {
      const veh = v.veh;
      const morning = night(veh, D), nx = nextActive(veh, D), evening = nx.day && !nx.open ? night(veh, nx.day) : null;
      const n = [];
      for (const nt of [morning, evening]) if (nt) for (const l of nt.legs) if (l.day === D)
        n.push({ ...l, start: rel(D, l.start), end: rel(D, l.end), night: nt.key });
      n.sort((a, b) => a.start - b.start);
      let emp = 0, rein = 0, svc = v.service_km || 0, est = 0, warn = [];
      for (const i of v.items) if (i.kind === "trip" && i.auto) { if (autoSt(D, veh, i) === "rejected") svc += i.km || 0; else rein += i.km || 0; }
      for (const i of v.items) if (i.kind === "empty" && !i.overlap && i.km) {
        const r = reinOf(D, veh, i);
        if (r) { rein += +r.rein_km || 0; emp += (+r.before_km || 0) + (+r.after_km || 0); } else { emp += i.km; if (i.est) est += i.km; }
      }
      let nk = 0, out = 0, inn = 0, over = 0, nrein = 0;
      const missing = [];
      for (const l of n) {
        if (l.kind === "rein") { rein += l.km || 0; nrein += l.km || 0; continue; }
        if (l.km == null) { missing.push(l); continue; }
        nk += l.km; if (!l.road) est += l.km;
        if (l.kind === "out") out += l.km; else if (l.kind === "in" || l.kind === "r_dep") inn += l.km; else over += l.km;
      }
      const flags = [...(morning ? morning.flags : []), ...(evening ? evening.flags.filter(f => f === "tight") : [])];
      if (nx.open) flags.push("open_end");
      return { veh, emp, rein, svc, n, nk, out, in: inn, over, nrein, est, missing, flags, morning, evening, next: nx,
        day: svc + emp + rein + nk };
    }
    Object.assign(M, { night, vehicleDay, prevActive, nextActive, branchOf, autoBranch, depotFor, autoSt, reinOf, leg, abs, rel });
    return M;
  }
  const api = { Model, hav, estKm, estMin, roadKey, dayNum, dayStr, addDays, AREA, OVMODES, LEGNAME, EMPTY_NIGHT, LOOKBACK };
  if (typeof module === "object" && module.exports) module.exports = api; else root.DH = api;
})(typeof self !== "undefined" ? self : this);
