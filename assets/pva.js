/* R53 "תכנון מול ביצוע" (David 18.11). Data: RPC get_pva (editor and above, checked in the database), one payload per
 * service day built by pipeline/pva/build.py. No driver data: trips are known by sidur and vehicle only (David 23.11). Session: the dashboard's (localStorage ys_session). */
(function () {
  "use strict";
  const SB = "https://xghfcdgettrcdciwwzbl.supabase.co", KEY = "sb_publishable_hCBsqYekz61JY6SFfT_sjw_-wj0QGXT", SKEY = "ys_session";
  const $ = s => document.querySelector(s), esc = s => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;"); };
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } }, lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { } };
  const nf = x => x == null ? "–" : (+x).toLocaleString("he-IL", { maximumFractionDigits: 1, minimumFractionDigits: (+x) % 1 ? 1 : 0 });
  const hm = m => m == null ? "" : `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const DOW = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
  const dlabel = d => { const x = new Date(d + "T12:00:00"); return `יום ${DOW[x.getDay()]} · ${x.getDate()}.${x.getMonth() + 1}`; };
  let SES = null; try { SES = JSON.parse(lsGet(SKEY) || "null"); } catch { }
  let OP = null, PLATFORM = false, ROLE = null, DAYS = [], GROUP = "place", SORT = "km", GEO = false, CTX = null, DAYF = "", Q = "", NOTES = [], CUR = null, SEL = null, OPENDAY = null, SELTRIP = null;

  // ---- session (same storage and refresh as the dashboard) ----
  async function http(url, opt = {}) {
    const r = await fetch(url, opt), t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { }
    if (!r.ok) { const e = new Error((j && (j.message || j.error_description || j.error)) || ("שגיאה " + r.status)); e.status = r.status; throw e; }
    return j;
  }
  async function token() {
    if (!SES) throw new Error("not_signed_in");
    if (SES.expires_at - 60 < Date.now() / 1000) {
      const o = JSON.parse(lsGet(SKEY) || "null");
      if (o && o.refresh_token !== SES.refresh_token && o.expires_at - 60 > Date.now() / 1000) SES = o;
      else {
        const j = await http(SB + "/auth/v1/token?grant_type=refresh_token", { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: SES.refresh_token }) });
        SES = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: +j.expires_at || Math.floor(Date.now() / 1000) + (+j.expires_in || 3600), user: j.user || SES.user };
        lsSet(SKEY, JSON.stringify(SES));
      }
    }
    return SES.access_token;
  }
  const sb = async (path, opt = {}) => http(SB + path, { ...opt, headers: { apikey: KEY, "Content-Type": "application/json", Authorization: "Bearer " + await token(), ...(opt.headers || {}) } });
  const rpc = (fn, args) => sb("/rest/v1/rpc/" + fn, { method: "POST", body: JSON.stringify(args) });
  const rows = (t, q) => sb(`/rest/v1/${t}?${q}`);
  const say = (t, err) => { const m = $("#msg"); m.textContent = t || ""; m.className = "msg" + (err ? " err" : ""); };

  async function access() {
    const uid = SES.user && SES.user.id || (await http(SB + "/auth/v1/user", { headers: { apikey: KEY, Authorization: "Bearer " + await token() } })).id;
    const [pa, ms, ops] = await Promise.all([rows("platform_admins", "select=user_id&user_id=eq." + uid), rows("memberships", "select=operator_id,role&user_id=eq." + uid), rows("operators", "select=id,slug,name,logo_url&order=name")]);
    PLATFORM = pa.length > 0;
    const want = new URLSearchParams(location.search).get("op") || lsGet("ys_op");
    OP = ops.find(o => o.slug === want) || ops[0] || null;
    ROLE = OP ? ((ms.find(m => m.operator_id === OP.id) || {}).role || (PLATFORM ? "admin" : null)) : null;
  }
  const allowed = () => PLATFORM || ROLE === "editor" || ROLE === "admin";

  // ---- excess (same rule as pipeline/pva/build.py excess_km) ----
  const kmOf = t => t.op_km != null ? t.op_km : (t.our_km || 0);
  const excess = t => t.kind === "empty" && t.status === "added" && !(t.forced && t.empty_kind !== "dispatcher") ? kmOf(t) : 0;
  const trips = () => DAYS.flatMap(d => d.sidurim.flatMap(s => s.trips.map(t => ({ ...t, day: d.day }))));
  // the list's day picker and search (sidur or vehicle number)
  // "רציפות גיאוגרפית" (David 19.11): only the legs marked for review, in the list and in its totals
  const shown = () => trips().filter(t => (!DAYF || t.day === DAYF) && (!Q || String(t.veh).includes(Q) || String(t.sidur).includes(Q)) && (!GEO || REVIEW.has(t.plaus)));

  // OP-DATA-7 blind seal: only days verified blind count in gate A metrics; a day without the field was built before the procedure
  const blind = day => (DAYS.find(d => d.day === day) || {}).blind === true;
  const NB = day => blind(day) ? "" : ` <span class="nb" title="${esc((DAYS.find(d => d.day === day) || {}).blind_why || "נבנה לפני נוהל החתימה")} · לא נספר במדדי שער A">לא עיוור</span>`;
  function cards() {
    { const ds = DAYS.filter(d => !DAYF || d.day === DAYF), nb = ds.filter(d => d.blind !== true).length;
      $("#cBlind").textContent = `${nf(ds.length - nb)} מתוך ${nf(ds.length)}`;
      $("#cBlindS").textContent = nb ? `${nf(nb)} ימים לא עיוורים: לא נספרים במדדי שער A` : "כל הימים חתומים ועיוורים"; }
    const T = trips().filter(t => t.kind === "empty" && (!DAYF || t.day === DAYF));
    const plan = T.filter(t => t.status !== "added").reduce((a, t) => a + (t.op_km || 0), 0);
    const act = T.filter(t => t.status !== "not_done").reduce((a, t) => a + kmOf(t), 0);
    const ex = T.reduce((a, t) => a + excess(t), 0), dis = T.filter(t => REVIEW.has(t.plaus)).reduce((a, t) => a + excess(t), 0);
    $("#cPlan").textContent = nf(Math.round(plan)); $("#cAct").textContent = nf(Math.round(act)); $("#cEx").textContent = nf(Math.round(ex)); $("#cDis").textContent = nf(Math.round(dis));
  }

  function groups() {
    const g = new Map();
    for (const t of shown()) {
      const k = gkey(t); if (k == null) continue;
      const e = excess(t); if (!e) continue;
      const x = g.get(k) || { k, km: 0, n: 0, r: 0, rk: 0, days: new Set() }; g.set(k, x);
      x.km += e; x.n++; x.days.add(t.day); if (REVIEW.has(t.plaus)) { x.r++; x.rk += e; }
    }
    const num = (a, b) => (+a.k - +b.k) || String(a.k).localeCompare(String(b.k), "he");
    const by = { km: (a, b) => b.km - a.km, veh: num, sid: num, place: (a, b) => String(a.k).localeCompare(String(b.k), "he"), date: (a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : 0 }[SORT];
    return [...g.values()].filter(x => x.km > 0).sort((a, b) => by(a, b) || b.km - a.km);
  }
  // one "מיון" box (David 19.11): ק״מ (מהגבוה) groups by place, largest first; the others group by that key in its order
  const gkey = t => GROUP === "place" ? (t.desc || `${place(t.a)} ← ${place(t.b)} (מסלול שאינו במפה)`) : GROUP === "veh" ? t.veh : GROUP === "date" ? t.day : t.sidur;
  const gname = k => GROUP === "place" ? k : GROUP === "veh" ? "רכב " + k : GROUP === "date" ? dlabel(k) : "סידור " + k;
  const REVIEW = new Set(["round_trip", "via_depot", "inconsistent", "end_of_day_review", "unknown"]);
  const PL = { explained: ["ok", "מוסבר"], end_of_day: ["ok", "סוף יום למוסך"], end_of_day_review: ["mid", "סוף יום, לבדיקה"], round_trip: ["bad", "הלוך ושוב"],
    via_depot: ["mid", "דרך מוסך"], inconsistent: ["bad", "לא מסתדר"], unknown: ["nd", "קצה לא ידוע"], estimated: ["mid", "קצה משוער"] };
  const PTAG = t => t.plaus && PL[t.plaus] ? `<span class="tag ${PL[t.plaus][0]}">${PL[t.plaus][1]}</span>` : "";

  function rank() {
    const G = groups(), top = G.length ? G[0].km : 1;
    if (SEL == null || !G.some(x => x.k === SEL)) SEL = G.length ? G[0].k : null;
    $("#rank").innerHTML = G.length ? G.map(x => `<li><button data-k="${esc(x.k)}" aria-current="${x.k === SEL}">
      <span class="nm">${esc(gname(x.k))}</span><span class="km">${nf(x.km)} ק״מ</span>
      <span class="s">${x.days.size === 1 ? "ביום אחד" : `ב־${x.days.size} ימים`} · ${x.n === 1 ? "נסיעה אחת" : `${x.n} נסיעות`}${x.r ? ` · ${x.r} לבדיקה (${nf(Math.round(x.rk * 10) / 10)} ק״מ)` : ""}</span><span class="bar" aria-hidden="true"><i style="width:${Math.max(4, x.km / top * 100)}%"></i></span></button></li>`).join("")
      : `<li class="empty">${Q ? "לא נמצא סידור או רכב כזה עם תוספות" : GEO ? "אין נסיעות לבדיקה בתקופה" : "אין תוספות בתקופה"}</li>`;
    $("#rank").querySelectorAll("button").forEach(b => b.onclick = () => { SEL = GROUP === "veh" ? +b.dataset.k : b.dataset.k; OPENDAY = null; SELTRIP = null; rank(); detail(); if (innerWidth < 900) $("#days").scrollIntoView({ behavior: "smooth" }); });
    detail();
  }

  const TAG = t => t.status === "not_done" ? `<span class="tag nd">לא בוצעה</span>` : t.empty_kind === "dispatcher" ? `<span class="tag disp">תוספת סדרן</span>`
    : t.forced ? `<span class="tag forced">מוכרחת</span>` : t.status === "added" ? `<span class="tag extra">נוספה</span>` : `<span class="tag plan">כמתוכנן</span>`;
  const place = p => p ? (p.depot ? p.name : p.name) : "?";
  // an end the report does not give, taken from the adjacent empty leg (David 19.11): shown as an estimate
  const pl = (t, k) => place(t[k]) + (t.inferred && t.inferred.includes(k) ? " (משוער)" : "");

  function detail() {
    const box = $("#days");
    if (SEL == null) { box.innerHTML = `<div class="empty">בחר שורה מהרשימה</div>`; drawMap(null); return; }
    const mine = shown().filter(t => gkey(t) === SEL && excess(t) > 0);
    const tot = mine.reduce((a, t) => a + excess(t), 0);
    const byDay = new Map(); mine.forEach(t => (byDay.get(t.day) || byDay.set(t.day, []).get(t.day)).push(t));
    const dayKm = d => byDay.get(d).reduce((a, t) => a + excess(t), 0);
    const ds = [...byDay.keys()].sort();
    if (OPENDAY == null) OPENDAY = ds.slice().sort((a, b) => dayKm(b) - dayKm(a))[0];
    box.innerHTML = `<h2>${esc(gname(SEL))} · ${nf(tot)} ק״מ ${GEO ? "לבדיקה" : "שהוסיף הסדרן"}</h2>` + ds.map(d => {
      const open = d === OPENDAY, L = byDay.get(d).sort((a, b) => a.t0 - b.t0);
      return `<div class="day"><button aria-expanded="${open}" data-d="${d}"><span>${dlabel(d)} · ${nf(dayKm(d))} ק״מ${NB(d)}</span><span aria-hidden="true">${open ? "▴" : "▾"}</span></button>
        ${open ? L.map((t, i) => { const k = `${d}|${i}`, on = CTX === k;
          return `<button class="trip${t.status === "not_done" ? " nd" : ""}" data-i="${k}" aria-current="${SELTRIP && SELTRIP.day === d && SELTRIP.i === i}">
          <span>${hm(t.t0)}</span><span>${esc(pl(t, "a"))} ← ${esc(pl(t, "b"))}<small class="sv">סידור ${esc(t.sidur)} · רכב ${esc(t.veh)}</small></span><span class="km">${nf(kmOf(t))} ק״מ</span><span>${TAG(t)} ${PTAG(t)}${nOf(t).length ? ` <span class="tag mid" title="יש הערה">✎ ${nOf(t).length}</span>` : ""}</span></button>
          <button class="ctxb" data-c="${k}" aria-expanded="${on}">${on ? "▴" : "▾"} מה הרכב עשה לפני ואחרי</button>${on ? ctx(t) : ""}`; }).join("") : ""}</div>`;
    }).join("");
    box.querySelectorAll(".day>button:not(.trip):not(.ctxb)").forEach(b => b.onclick = () => { OPENDAY = OPENDAY === b.dataset.d ? "" : b.dataset.d; SELTRIP = null; detail(); });
    box.querySelectorAll(".ctxb").forEach(b => b.onclick = () => { CTX = CTX === b.dataset.c ? null : b.dataset.c; detail(); });
    box.querySelectorAll(".trip").forEach(b => b.onclick = () => {
      const [d, i] = b.dataset.i.split("|"); SELTRIP = { day: d, i: +i }; detail();
      if (GEO) side(); else if (innerWidth < 900) $("#map").scrollIntoView({ behavior: "smooth" });
    });
    const L = OPENDAY && byDay.get(OPENDAY) ? byDay.get(OPENDAY).sort((a, b) => a.t0 - b.t0) : [];
    if (!SELTRIP && L.length) { const i = Math.max(0, L.findIndex(t => excess(t) > 0)); SELTRIP = { day: OPENDAY, i }; box.querySelector(`[data-i="${OPENDAY}|${i}"]`)?.setAttribute("aria-current", "true"); }
    drawMap(SELTRIP && byDay.get(SELTRIP.day) ? byDay.get(SELTRIP.day)[SELTRIP.i] : null);
    if (!$("#side").hidden) side();
  }

  // ---- the side panel of "רציפות גיאוגרפית": the clicked leg's sidur within its vehicle's day, prev/next leg for review.
  // A dispatcher's added leg is a sidur of its own (one leg, 10.11), so the vehicle's day is what shows the sidur's place.
  function flagged() {  // every listed leg in the list's order, with its place in detail() (group, day, index)
    return groups().flatMap(G => {
      const mine = shown().filter(t => gkey(t) === G.k && excess(t) > 0), ds = [...new Set(mine.map(t => t.day))].sort();
      return ds.flatMap(d => mine.filter(t => t.day === d).sort((a, b) => a.t0 - b.t0).map((t, i) => ({ k: G.k, day: d, i, t })));
    });
  }
  function side() {
    const F = flagged(), at = SELTRIP ? F.findIndex(x => x.k === SEL && x.day === SELTRIP.day && x.i === SELTRIP.i) : -1;
    if (!GEO || at < 0) { $("#side").hidden = true; return; }
    const t = F[at].t, S = trips().filter(x => x.day === t.day && (x.veh === t.veh || (x.veh == null && String(x.sidur) === String(t.sidur)))).sort((a, b) => a.t0 - b.t0);
    $("#side").hidden = false;
    $("#sdTitle").textContent = `סידור ${t.sidur} · רכב ${t.veh}`;
    $("#sdPos").textContent = `${dlabel(t.day)} · נסיעה ${at + 1} מתוך ${F.length} לבדיקה · כל היום של הרכב, הסידור מודגש`;
    $("#sdPrev").disabled = at === 0; $("#sdNext").disabled = at === F.length - 1;
    const same = x => String(x.sidur) === String(t.sidur);
    $("#sdList").innerHTML = S.map((x, j) => `<li class="${x.t0 === t.t0 && x.kind === t.kind && same(x) ? "me" : same(x) ? "sd" : ""}${x.status === "not_done" ? " nd" : ""}"><button data-j="${j}"${x.kind === "empty" ? "" : " disabled"}>
      <span>${hm(x.t0)}</span><span>${x.kind === "service" ? "קו " + esc(x.line || "") : "ריקה"} · סידור ${esc(x.sidur)}</span><span class="km">${nf(kmOf(x))} ק״מ</span>
      <span class="pl">${esc(pl(x, "a"))} ← ${esc(pl(x, "b"))}</span><span class="tg">${x.kind === "empty" ? TAG(x) + " " + PTAG(x) : ""}</span></button></li>`).join("");
    $("#sdList").querySelectorAll("button[data-j]").forEach(b => b.onclick = () => drawMap(S[+b.dataset.j]));
    const r1 = x => nf(Math.round(x * 10) / 10), tot = L => { const D = L.filter(x => x.status !== "not_done"), sum = f => D.reduce((a, x) => a + f(x), 0);
      return `ק״מ בשירות ${r1(sum(x => x.kind === "service" ? (x.op_km || 0) : 0))} · ק״מ ריקים ${r1(sum(x => x.kind === "empty" ? kmOf(x) : 0))} · מתוכם הוסיף הסדרן ${r1(sum(excess))}`; };
    $("#sdTot").innerHTML = `<b>סה״כ סידור ${esc(t.sidur)}</b><span>${tot(S.filter(same))}</span><b>סה״כ יום הרכב</b><span>${tot(S)}</span>`;
    $("#sdList .me")?.scrollIntoView({ block: "nearest" });
    const go = d => { const n = F[at + d]; if (!n) return; SEL = n.k; OPENDAY = n.day; SELTRIP = { day: n.day, i: n.i }; CTX = null; rank(); };
    $("#sdPrev").onclick = () => go(-1); $("#sdNext").onclick = () => go(1);
  }
  $("#sdClose").onclick = () => { $("#side").hidden = true; };

  // the vehicle's day around a leg: from the empty leg before the service block that precedes it to the empty leg after
  // the service block that follows it, so the dispatcher's reasoning can be followed
  function ctx(t) {
    const V = trips().filter(x => x.day === t.day && x.veh === t.veh && x.status !== "not_done").sort((a, b) => a.t0 - b.t0);
    let i = V.findIndex(x => x.t0 === t.t0 && x.sidur === t.sidur && x.kind === t.kind); if (i < 0) return "";
    let a = i; while (a > 0 && V[a - 1].kind === "empty") a--; while (a > 0 && V[a - 1].kind !== "empty") a--; if (a > 0) a--;
    let b = i; while (b + 1 < V.length && V[b + 1].kind === "empty") b++; while (b + 1 < V.length && V[b + 1].kind !== "empty") b++; if (b + 1 < V.length) b++;
    return `<ol class="ctx">${V.slice(a, b + 1).map(x => `<li${x === V[i] ? ' class="me"' : ""}><span>${hm(x.t0)}</span><span>${x.kind === "service" ? "קו " + esc(x.line || "") : "ריקה"} · סידור ${esc(x.sidur)}</span>
      <span>${esc(pl(x, "a"))} ← ${esc(pl(x, "b"))}</span><span>${x.kind === "empty" ? TAG(x) : ""}</span></li>`).join("")}</ol>`;
  }

  // ---- notes: a correction or explanation on one trip (David 19.11). Server: add_pva_note / pva_notes (editor and above);
  // the local preview keeps them in this browser only (pulled from here for review).
  const NTOP = { place: "המקום", km: "הק״מ", mark: "הסימון", other: "אחר" }, LKEY = "pva_notes_local";
  const nOf = t => NOTES.filter(n => n.day === t.day && String(n.sidur) === String(t.sidur) && +n.t0 === +t.t0);
  async function loadNotes(f, t) {
    if (LOCAL) { try { NOTES = JSON.parse(lsGet(LKEY) || "[]"); } catch { NOTES = []; } return; }
    try { NOTES = (await rpc("pva_notes", { p_operator: OP.id, p_from: f, p_to: t })) || []; } catch { NOTES = []; }
  }
  function notesHtml(t) {
    const L = nOf(t);
    return (L.length ? `<ul class="notes">${L.map(n => `<li>${n.mine || LOCAL ? `<button data-del="${esc(n.id)}" aria-label="מחיקת ההערה">מחיקה</button>` : ""}<b>${NTOP[n.topic] || ""}</b>${n.fix ? ` · הערך הנכון: ${esc(n.fix)}` : ""}<br>${esc(n.body)}</li>`).join("")}</ul>` : "")
      + `<div class="nb"><button class="btn" id="bNote">✎ תיקון או הסבר</button></div>`;
  }
  function wireNotes(t) {
    $("#bNote").onclick = () => { CUR = t; $("#nHead").textContent = `סידור ${t.sidur} · רכב ${t.veh} · ${dlabel(t.day)} · ${hm(t.t0)} · ${pl(t, "a")} ← ${pl(t, "b")}`;
      $("#nTopic").value = t.plaus ? "mark" : "km"; $("#nFix").value = ""; $("#nBody").value = ""; $("#nMsg").textContent = ""; $("#dlgNote").showModal(); $("#nBody").focus(); };
    document.querySelectorAll("#mapInfo [data-del]").forEach(b => b.onclick = async () => {
      if (!confirm("למחוק את ההערה?")) return;
      try { if (LOCAL) { NOTES = NOTES.filter(n => n.id !== b.dataset.del); lsSet(LKEY, JSON.stringify(NOTES)); } else { await rpc("delete_pva_note", { p_id: b.dataset.del }); NOTES = NOTES.filter(n => n.id !== b.dataset.del); } }
      catch (e) { say("המחיקה נכשלה: " + e.message, true); return; }
      detail();
    });
  }
  $("#nClose").onclick = () => $("#dlgNote").close();
  $("#nSave").onclick = async () => {
    const body = $("#nBody").value.trim(), t = CUR, m = $("#nMsg");
    if (!body) { m.className = "msg err"; m.textContent = "צריך לכתוב הסבר"; return; }
    const n = { day: t.day, sidur: String(t.sidur), veh: t.veh, t0: t.t0, topic: $("#nTopic").value, fix: $("#nFix").value.trim(), body, mine: true };
    $("#nSave").disabled = true; m.className = "msg"; m.textContent = "שומר…";
    try {
      if (LOCAL) { n.id = crypto.randomUUID(); n.at = new Date().toISOString(); NOTES.push(n); lsSet(LKEY, JSON.stringify(NOTES)); }
      else { n.id = await rpc("add_pva_note", { p_operator: OP.id, p_day: n.day, p_sidur: n.sidur, p_veh: n.veh, p_t0: n.t0, p_topic: n.topic, p_fix: n.fix, p_body: n.body }); NOTES.push(n); }
    } catch (e) { m.className = "msg err"; m.textContent = "השמירה נכשלה: " + e.message; $("#nSave").disabled = false; return; }
    $("#nSave").disabled = false; $("#dlgNote").close(); detail();
  };

  // ---- map card (Leaflet from assets/vendor, our route from the public OSRM, as in the dashboard) ----
  let map = null, lay = null, drawn = 0;
  function leaflet() {
    if (window.L) return Promise.resolve();
    return new Promise((ok, bad) => {
      const css = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "assets/vendor/leaflet/leaflet.css" });
      const js = Object.assign(document.createElement("script"), { src: "assets/vendor/leaflet/leaflet.js" });
      js.onload = ok; js.onerror = bad; document.head.append(css, js);
    });
  }
  const VERD = { match: ["ok", "תואם"], third: ["bad", "פער, לבדיקה פרטנית"], op: ["bad", "פער, לבדיקה פרטנית"], ours: ["bad", "פער, לבדיקה פרטנית"], pending: ["bad", "פער, לבדיקה פרטנית"], "n/a": ["nd", "אין השוואה"] };
  async function drawMap(t) {
    const info = $("#mapInfo"), my = ++drawn;
    if (!t) { info.innerHTML = ""; $("#mapLeg").innerHTML = ""; if (lay) lay.clearLayers(); return; }
    const gap = t.op_km != null && t.our_km != null ? Math.abs(t.op_km - t.our_km) : null, v = VERD[t.verdict] || VERD["n/a"];
    info.innerHTML = (t.plaus_why ? `<p class="why">${PTAG(t)} ${esc(t.plaus_why)}</p>` : "") + `<table><tr><td>ק״מ לפי המפעיל</td><td>${nf(t.op_km)}</td></tr><tr><td>ק״מ לפי הניתוב שלנו</td><td>${nf(t.our_km)}</td></tr></table>
      <div class="foot"><span class="tag ${v[0]}">${v[1]}${gap != null ? ` (פער ${nf(Math.round(gap * 10) / 10)} ק״מ)` : ""}</span><span>סידור ${esc(t.sidur)} · רכב ${esc(t.veh)}${t.end_src === "unresolved" ? " · קצה לא ידוע" : t.end_src === "inferred" ? " · קצה משוער (לא כתוב בדוח)" : ""}</span></div>`;
    info.insertAdjacentHTML("beforeend", notesHtml(t)); wireNotes(t);
    $("#mapLeg").innerHTML = `<span><i class="ln"></i> הניתוב שלנו</span><span>${esc(pl(t, "a"))} ← ${esc(pl(t, "b"))}</span>`;
    try { await leaflet(); } catch { info.insertAdjacentHTML("beforeend", `<div class="msg err">המפה לא נטענה</div>`); return; }
    if (my !== drawn) return;
    if (!map) {
      map = L.map("map", { zoomControl: true, attributionControl: true }); lay = L.layerGroup().addTo(map);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
    }
    lay.clearLayers();
    if (!t.a || !t.b) { map.setView([31.78, 35.2], 12); return; }
    const A = [t.a.lat, t.a.lon], B = [t.b.lat, t.b.lon];
    L.circleMarker(A, { radius: 8, color: "#2E9E4F", fillOpacity: 1 }).bindTooltip(esc(pl(t, "a")), { permanent: true, direction: "top" }).addTo(lay);
    L.circleMarker(B, { radius: 8, color: "#C62828", fillOpacity: 1 }).bindTooltip(esc(pl(t, "b")), { permanent: true, direction: "top" }).addTo(lay);
    map.fitBounds([A, B], { padding: [40, 40] });
    if (t.geom && t.geom.length > 1) {  // the road our km was measured on (R13)
      L.polyline(t.geom, { color: "#E8871E", weight: 5 }).addTo(lay); map.fitBounds(L.latLngBounds(t.geom).extend(A).extend(B), { padding: [30, 30] });
      return;
    }
    $("#mapLeg").insertAdjacentHTML("beforeend", `<span>(הקו משוער, ממסלול רכב ציבורי; הק״מ בטבלה מהניתוב שלנו)</span>`);
    try {
      const pts = await YMAP.osrmLine(A, B); if (my !== drawn) return;
      L.polyline(pts, { color: "#E8871E", weight: 3, dashArray: "6 6" }).addTo(lay); map.fitBounds(L.latLngBounds(pts).extend(A).extend(B), { padding: [30, 30] });
    } catch { L.polyline([A, B], { color: "#E8871E", weight: 3, dashArray: "4 6" }).addTo(lay); }
  }

  // ---- other tabs (Task 7) ----
  function tab(id) {
    ["Excess", "Sid", "Gap", "Les", "Unx"].forEach(k => { const on = "t" + k === id; $("#t" + k).setAttribute("aria-selected", on); $("#p" + k).hidden = !on; });
    if (window.PVA_TABS && window.PVA_TABS[id]) window.PVA_TABS[id](DAYS, { esc, nf, hm, dlabel, TAG, place, kmOf });
  }
  document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => tab(b.id));

  // local preview (localhost + ?local=1): the built files in pipeline/cache, no database (they are never deployed)
  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has("local");
  async function localDays(f, t) {
    const out = [];
    for (let d = new Date(f + "T12:00:00"); d <= new Date(t + "T12:00:00"); d = new Date(d.getTime() + 864e5)) {
      const r = await fetch(`pipeline/cache/pva_${d.toISOString().slice(0, 10)}.json`, { cache: "no-store" }); if (r.ok) out.push(await r.json());
    }
    return out;
  }
  async function load() {
    const f = $("#dFrom").value, t = $("#dTo").value; if (!f || !t) return;
    say("טוען…");
    try { DAYS = LOCAL ? await localDays(f, t) : (await rpc("get_pva", { p_operator: OP.id, p_from: f, p_to: t })) || []; }
    catch (e) { say("הטעינה נכשלה: " + e.message, true); return; }
    await loadNotes(f, t);
    say(DAYS.length ? "" : "אין נתונים לתקופה הזו");
    const df = $("#fDay"); df.innerHTML = `<option value="">כל הימים</option>` + DAYS.map(d => `<option value="${esc(d.day)}">${dlabel(d.day)}${d.blind === true ? "" : " · לא עיוור"}</option>`).join("");
    DAYF = DAYS.length === 1 ? "" : (DAYS.some(d => d.day === DAYF) ? DAYF : ""); df.value = DAYF;
    reset(); cards(); rank();
    const cur = document.querySelector(".tabs [aria-selected=true]").id; if (cur !== "tExcess") tab(cur);
  }

  // a built day -> database: platform admin only (put_pva checks it, with MFA). The file goes from this computer straight
  // to the database; the pipeline output (pipeline/cache) is never in the repo.
  async function loadFiles(files) {
    let n = 0, last = null;
    for (const f of files) {
      let p; try { p = JSON.parse(await f.text()); } catch { say(`${f.name}: הקובץ לא נקרא`, true); return; }
      if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(p.day || "") || !Array.isArray(p.sidurim)) { say(`${f.name}: זה לא קובץ יום של תכנון מול ביצוע`, true); return; }
      say(`שומר את ${p.day}…`);
      try { await rpc("put_pva", { p_operator: OP.id, p_day: p.day, p_payload: p }); n++; last = p.day; } catch (e) { say(`השמירה של ${p.day} נכשלה: ${e.message}`, true); return; }
    }
    say(n ? `נשמרו ${n === 1 ? "יום אחד" : n + " ימים"}` : "");
    if (last) { if ($("#dFrom").value > last || !$("#dFrom").value) $("#dFrom").value = last; if ($("#dTo").value < last || !$("#dTo").value) $("#dTo").value = last; load(); }
  }

  const reset = () => { SEL = null; OPENDAY = null; SELTRIP = null; CTX = null; $("#side").hidden = true; };
  $("#fSort").onchange = e => { SORT = e.target.value; GROUP = SORT === "km" ? "place" : SORT; reset(); rank(); };
  $("#bGeo").onclick = () => { GEO = !GEO; $("#bGeo").setAttribute("aria-pressed", GEO); reset(); rank(); };
  $("#fDay").onchange = e => { DAYF = e.target.value; reset(); cards(); rank(); };
  $("#fQ").oninput = e => { Q = e.target.value.trim(); reset(); rank(); };
  const full = on => { const c = $(".mapcard"); c.classList.toggle("full", on); $("#bFull").textContent = on ? "✕ סגירה" : "⛶ מסך מלא"; $("#bFull").setAttribute("aria-pressed", on); if (map) setTimeout(() => { map.invalidateSize(); const b = L.featureGroup(lay.getLayers()).getBounds(); if (b.isValid()) map.fitBounds(b, { padding: [40, 40] }); }, 80); };
  $("#bFull").onclick = () => full(!$(".mapcard").classList.contains("full"));
  document.addEventListener("keydown", e => { if (e.key !== "Escape") return; if ($(".mapcard").classList.contains("full")) full(false); else if (!$("#side").hidden) $("#side").hidden = true; });
  $("#bLoad").onclick = load; $("#bFile").onclick = () => $("#fFile").click(); $("#fFile").onchange = e => { const F = [...e.target.files]; e.target.value = ""; if (F.length) loadFiles(F); };

  (async () => {
    if (LOCAL) { $("#sub").textContent = "תצוגה מקומית מקבצי הבנייה (לא מהשרת)"; $("#dFrom").value = $("#dTo").value = new URLSearchParams(location.search).get("day") || "2026-11-10"; load(); return; }
    if (!SES) { say(""); $("main").innerHTML = `<div class="empty">צריך להיכנס קודם. <a href="index.html">כניסה לדשבורד</a></div>`; return; }
    try { await access(); } catch (e) { say("אין חיבור: " + e.message, true); return; }
    if (!OP || !allowed()) { $("main").innerHTML = `<div class="empty">אין לך הרשאה למסך הזה. הוא פתוח לעורכים ומעלה.</div>`; $("#cards").hidden = true; return; }
    $("#sub").textContent = `${OP.name} · קווים עירוניים`; document.title = `יאללה־סע · תכנון מול ביצוע · ${OP.name}`;
    if (OP.logo_url) { $("#opLogo").innerHTML = `<img src="${esc(OP.logo_url)}" alt="${esc(OP.name)}">`; $("#opLogo").hidden = false; }
    $("#bFile").hidden = !PLATFORM;
    let days = []; try { days = (await rpc("pva_days", { p_operator: OP.id })) || []; } catch { }
    const last = days.length ? days[days.length - 1] : new Date().toISOString().slice(0, 10);
    const first = days.length ? days[Math.max(0, days.length - 7)] : last;
    $("#dFrom").value = first; $("#dTo").value = last;
    if (days.length) load(); else say("עדיין אין ימים שמורים");
  })();
})();
