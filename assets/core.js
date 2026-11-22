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
      let emp = 0, rein = 0, svc = v.service_km || 0, est = 0, car = 0, warn = [];
      for (const i of v.items) if (i.kind === "trip" && i.auto) { if (autoSt(D, veh, i) === "rejected") svc += i.km || 0; else rein += i.km || 0; }
      for (const i of v.items) if (i.kind === "empty" && !i.overlap && i.km) {
        if (i.fb) { car += i.km; continue; }  // public car-OSRM fallback: "הערכת רכב, לא אוטובוס", in no sum (ADR-0009 #10)
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
      return { veh, emp, rein, svc, n, nk, out, in: inn, over, nrein, est, car, missing, flags, morning, evening, next: nx,
        day: svc + emp + rein + nk };
    }
    Object.assign(M, { night, vehicleDay, prevActive, nextActive, branchOf, autoBranch, depotFor, autoSt, reinOf, leg, abs, rel });
    return M;
  }
  // ---- manual block edits (fixing data errors) ----
  // edits: rows of block_edits {id, day, veh, action, payload, created_at}: delete / replace / add / times / move a trip,
  // the trip named by its scheduled minute (payload.sched); "leg" = another origin (a, frm) and/or destination (b, to) for
  // the empty leg before the trip payload.sched (e.g. the GPS lost the bus 700 m before the terminal it really reached). Applied in order (payload.seq, then created_at) to a copy of
  // the day: the original stays untouched (shown on demand). Edited vehicles get their empty legs, totals and start/end
  // recomputed; a leg whose two ends did not change keeps the pipeline's road km. Returns a day in the same shape as a
  // day file (also what the savings engine reads through getBlocks), plus day.edits = {applied, orphans}.
  const editOrder = (a, b) => ((a.payload || {}).seq ?? Date.parse(a.created_at || 0)) - ((b.payload || {}).seq ?? Date.parse(b.created_at || 0)) || String(a.id).localeCompare(String(b.id));
  function applyBlockEdits(day, edits, opts) {
    opts = opts || {};
    const es = (edits || []).filter(e => e && e.day === day.day).slice().sort(editOrder);
    if (!es.length) return day;
    const road = opts.road || (() => null);
    const V = new Map(day.vehicles.map(v => [v.veh, v]));
    const T = new Map(), cityOf = (v, end) => v ? (end ? v.last_d : v.first_o)[2] : "";
    const tripsOf = veh => {
      if (!T.has(veh)) { const v = V.get(veh), ts = v ? v.items.filter(i => i.kind === "trip").map(t => ({ ...t })) : [];
        if (v && ts.length) { ts[0].ca = ts[0].ca || cityOf(v, false); ts[ts.length - 1].cb = ts[ts.length - 1].cb || cityOf(v, true); }
        T.set(veh, ts); }
      return T.get(veh);
    };
    const applied = [], orphans = [], LEGS = new Map(); // veh -> Map(next trip sched -> leg edit)
    for (const e of es) {
      const p = e.payload || {}, ts = tripsOf(e.veh), k = p.sched != null ? ts.findIndex(t => t.sched === +p.sched) : -1;
      const tag = t => Object.assign(t, { edited: true, edit_id: e.id, edit: { action: e.action, by: p.by || null, at: e.created_at || null } });
      if (e.action !== "add" && k < 0) { orphans.push(e); continue; }
      if (e.action === "delete") ts.splice(k, 1);
      else if (e.action === "times") tag(Object.assign(ts[k], { start: +p.start, end: Math.max(+p.end, +p.start + 1) }));
      else if (e.action === "replace" || e.action === "add") {
        if (!p.o || !p.d || p.start == null) { orphans.push(e); continue; }
        const old = e.action === "replace" ? ts[k] : null;
        const nt = tag({ kind: "trip", line: String(p.line || "?"), frm: p.frm || "", to: p.to || "", a: p.o, b: p.d, ca: p.ca || "", cb: p.cb || "",
          km: +p.km || 0, km_plan: +p.km || 0, cls: p.cls || (old && old.cls) || "לא ידוע", start: +p.start, end: +p.start + Math.max(+p.dur || 0, 1),
          sched: old ? old.sched : (p.sched != null ? +p.sched : +p.start), ...(p.auto ? { auto: true } : {}) });
        if (old) ts[k] = nt; else ts.push(nt);
      } else if (e.action === "leg") {
        if (k <= 0 || (!p.a && !p.b)) { orphans.push(e); continue; } // no trip before it: there is no empty leg to change
        if (!LEGS.has(e.veh)) LEGS.set(e.veh, new Map()); LEGS.get(e.veh).set(+p.sched, e);
      } else if (e.action === "move") {
        if (!p.to_veh || p.to_veh === e.veh) { orphans.push(e); continue; }
        const [t] = ts.splice(k, 1); tripsOf(String(p.to_veh)).push(tag({ ...t, moved_from: e.veh }));
      } else { orphans.push(e); continue; }
      applied.push(e.id);
    }
    const out = [];
    for (const v of day.vehicles) if (!T.has(v.veh)) out.push(v);
    for (const [veh, trips] of T) {
      if (!trips.length) continue; // every trip deleted / moved away: the vehicle did not run
      const v0 = V.get(veh);
      trips.sort((a, b) => a.start - b.start || a.sched - b.sched);
      const old = new Map(), info = [];
      if (v0) {
        let prev = null;
        for (const i of v0.items) { if (i.kind === "trip") prev = i; else if (i.kind === "empty") old.set(i.next_sched, { leg: i, prev }); else info.push(i); }
      }
      const items = [];
      trips.forEach((t, n) => {
        if (n) {
          const p = trips[n - 1], gap = t.start - p.end, o = old.get(t.sched);
          const le = LEGS.has(veh) ? LEGS.get(veh).get(t.sched) : null, lp = le ? le.payload : null;
          const same = !le && o && o.prev && o.prev.sched === p.sched && !p.edited && !t.edited;
          let leg;
          if (le) { // origin / destination chosen by hand: routed again from the chosen points
            const A = lp.a || p.b, B = lp.b || t.a, r = hav(A, B) < 0.05 ? { km: 0, min: 0 } : road(A, B), km = r ? r.km : Math.round(estKm(A, B) * 10) / 10;
            leg = { kind: "empty", start: p.end, end: t.start, km, drive_min: r ? r.min : Math.round(estMin(km) * 10) / 10, frm: lp.a ? lp.frm || "" : p.to, to: lp.b ? lp.to || "" : t.frm,
              next_sched: t.sched, a: A, b: B, ...(r ? {} : { est: true }), edited: true, leg_edit: { id: le.id, by: lp.by || null, at: le.created_at || null, a: !!lp.a, b: !!lp.b },
              ...(o ? { orig: { a: o.leg.a, b: o.leg.b, frm: o.leg.frm, to: o.leg.to, km: o.leg.km } } : {}) };
          }
          else if (same) leg = { ...o.leg };
          else {
            const r = hav(p.b, t.a) < 0.05 ? { km: 0, min: 0 } : road(p.b, t.a), km = r ? r.km : Math.round(estKm(p.b, t.a) * 10) / 10;
            leg = { kind: "empty", start: p.end, end: t.start, km, drive_min: r ? r.min : Math.round(estMin(km) * 10) / 10, frm: p.to, to: t.frm,
              next_sched: t.sched, a: p.b, b: t.a, ...(r ? {} : { est: true }), edited: true };
          }
          leg.start = p.end; leg.end = t.start; delete leg.overlap; delete leg.tight;
          if (gap < 0) leg.overlap = true;
          else if (leg.km > 2 && (leg.drive_min > gap + 10 || gap === 0 || leg.km / (gap / 60) > 100)) leg.tight = true;
          items.push(leg);
        }
        items.push(t);
      });
      for (const i of info) items.push(i);
      items.sort((x, y) => (x.kind === "empty" ? x.end : x.start) - (y.kind === "empty" ? y.end : y.start) || ({ empty: 0, ghost: 1, dup: 1, trip: 2 }[x.kind] - { empty: 0, ghost: 1, dup: 1, trip: 2 }[y.kind]));
      const f = trips[0], l = trips[trips.length - 1];
      const cls = (() => { const c = {}; for (const t of trips) if (!t.auto) c[t.cls] = (c[t.cls] || 0) + 1; const b = Object.entries(c).sort((x, y) => y[1] - x[1]); return b.length ? b[0][0] : f.cls; })();
      out.push({ ...(v0 || {}), veh, cls: v0 ? v0.cls : cls, edited: true, items,
        first_o: [f.a[0], f.a[1], f.ca || cityOf(v0, false)], last_d: [l.b[0], l.b[1], l.cb || cityOf(v0, true)],
        service_km: Math.round(trips.filter(t => !t.auto).reduce((s, t) => s + (+t.km || 0), 0) * 10) / 10,
        empty_day_km: Math.round(items.filter(i => i.kind === "empty" && !i.overlap).reduce((s, i) => s + (+i.km || 0), 0) * 10) / 10 });
    }
    out.sort((a, b) => a.veh < b.veh ? -1 : a.veh > b.veh ? 1 : 0);
    return { ...day, vehicles: out, edits: { applied, orphans: orphans.map(e => e.id) } };
  }
  // the cross-day index entry of a (possibly edited) vehicle-day, same layout as pipeline ends_entry()
  function endsEntry(v) {
    const ts = v.items.filter(i => i.kind === "trip"), f = ts[0], l = ts[ts.length - 1];
    return [f.start, v.first_o[0], v.first_o[1], v.first_o[2], f.frm, l.end, v.last_d[0], v.last_d[1], v.last_d[2], l.to, l.line, v.cls];
  }
  // ends index with the edited days laid over it (days: {day: edited day object})
  function endsWithEdits(ends, editedDays) {
    const out = { ...ends };
    for (const [d, J] of Object.entries(editedDays || {})) { if (!J || !J.edits) continue; out[d] = {}; for (const v of J.vehicles) out[d][v.veh] = endsEntry(v); }
    return out;
  }
  const api = { Model, hav, estKm, estMin, roadKey, dayNum, dayStr, addDays, AREA, OVMODES, LEGNAME, EMPTY_NIGHT, LOOKBACK,
    applyBlockEdits, endsEntry, endsWithEdits };
  if (typeof module === "object" && module.exports) module.exports = api; else root.DH = api;
})(typeof self !== "undefined" ? self : this);
