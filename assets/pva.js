/* R53 "תכנון מול ביצוע" (David 18.11). Data: RPC get_pva (editor and above, checked in the database), one payload per
 * service day built by pipeline/pva/build.py. Drivers by code only. Session: the dashboard's (localStorage ys_session). */
(function () {
  "use strict";
  const SB = "https://xghfcdgettrcdciwwzbl.supabase.co", KEY = "sb_publishable_hCBsqYekz61JY6SFfT_sjw_-wj0QGXT", SKEY = "ys_session";
  const $ = s => document.querySelector(s), esc = s => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } }, lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { } };
  const nf = x => x == null ? "–" : (+x).toLocaleString("he-IL", { maximumFractionDigits: 1, minimumFractionDigits: (+x) % 1 ? 1 : 0 });
  const hm = m => m == null ? "" : `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const DOW = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
  const dlabel = d => { const x = new Date(d + "T12:00:00"); return `יום ${DOW[x.getDay()]} · ${x.getDate()}.${x.getMonth() + 1}`; };
  let SES = null; try { SES = JSON.parse(lsGet(SKEY) || "null"); } catch { }
  let OP = null, PLATFORM = false, ROLE = null, DAYS = [], GROUP = "drv", SEL = null, OPENDAY = null, SELTRIP = null;

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

  function cards() {
    const T = trips().filter(t => t.kind === "empty");
    const plan = T.filter(t => t.status !== "added").reduce((a, t) => a + (t.op_km || 0), 0);
    const act = T.filter(t => t.status !== "not_done").reduce((a, t) => a + kmOf(t), 0);
    const ex = T.reduce((a, t) => a + excess(t), 0), dis = T.filter(t => t.empty_kind === "dispatcher").reduce((a, t) => a + excess(t), 0);
    $("#cPlan").textContent = nf(Math.round(plan)); $("#cAct").textContent = nf(Math.round(act)); $("#cEx").textContent = nf(Math.round(ex)); $("#cDis").textContent = nf(Math.round(dis));
  }

  function groups() {
    const key = t => GROUP === "drv" ? t.driver : t.veh, g = new Map();
    for (const t of trips()) {
      const k = key(t); if (k == null) continue;
      const x = g.get(k) || { k, km: 0, n: 0, days: new Set() }; g.set(k, x);
      const e = excess(t); if (e) { x.km += e; x.n++; x.days.add(t.day); }
    }
    return [...g.values()].filter(x => x.km > 0).sort((a, b) => b.km - a.km);
  }
  const gname = k => GROUP === "drv" ? (k === "?" ? "נהג לא ידוע" : "נהג " + k) : "רכב " + k;

  function rank() {
    const G = groups(), top = G.length ? G[0].km : 1;
    if (SEL == null || !G.some(x => x.k === SEL)) SEL = G.length ? G[0].k : null;
    $("#rank").innerHTML = G.length ? G.map(x => `<li><button data-k="${esc(x.k)}" aria-current="${x.k === SEL}">
      <span class="nm">${esc(gname(x.k))}</span><span class="km">${nf(x.km)} ק״מ</span>
      <span class="s">ב־${x.days.size} ימים · ${x.n} נסיעות</span><span class="bar" aria-hidden="true"><i style="width:${Math.max(4, x.km / top * 100)}%"></i></span></button></li>`).join("")
      : `<li class="empty">אין ק״מ מעבר לתכנון בתקופה</li>`;
    $("#rank").querySelectorAll("button").forEach(b => b.onclick = () => { SEL = GROUP === "veh" ? +b.dataset.k : b.dataset.k; OPENDAY = null; SELTRIP = null; rank(); detail(); if (innerWidth < 900) $("#days").scrollIntoView({ behavior: "smooth" }); });
    detail();
  }

  const TAG = t => t.status === "not_done" ? `<span class="tag nd">לא בוצעה</span>` : t.empty_kind === "dispatcher" ? `<span class="tag disp">תוספת סדרן</span>`
    : t.forced ? `<span class="tag forced">מוכרחת</span>` : t.status === "added" ? `<span class="tag extra">נוספה</span>` : `<span class="tag plan">כמתוכנן</span>`;
  const place = p => p ? (p.depot ? p.name : p.name) : "?";

  function detail() {
    const box = $("#days");
    if (SEL == null) { box.innerHTML = `<div class="empty">בחר נהג מהרשימה</div>`; drawMap(null); return; }
    const mine = trips().filter(t => (GROUP === "drv" ? t.driver === SEL : t.veh === SEL) && t.kind === "empty");
    const tot = mine.reduce((a, t) => a + excess(t), 0);
    const byDay = new Map(); mine.forEach(t => (byDay.get(t.day) || byDay.set(t.day, []).get(t.day)).push(t));
    const dayKm = d => byDay.get(d).reduce((a, t) => a + excess(t), 0);
    const ds = [...byDay.keys()].sort();
    if (OPENDAY == null) OPENDAY = ds.slice().sort((a, b) => dayKm(b) - dayKm(a))[0];
    box.innerHTML = `<h2>${esc(gname(SEL))} · ${nf(tot)} ק״מ מעבר לתכנון</h2>` + ds.map(d => {
      const open = d === OPENDAY, L = byDay.get(d).sort((a, b) => a.t0 - b.t0);
      return `<div class="day"><button aria-expanded="${open}" data-d="${d}"><span>${dlabel(d)} · ${nf(dayKm(d))} ק״מ</span><span aria-hidden="true">${open ? "▴" : "▾"}</span></button>
        ${open ? L.map((t, i) => `<button class="trip${t.status === "not_done" ? " nd" : ""}" data-i="${d}|${i}" aria-current="${SELTRIP && SELTRIP.day === d && SELTRIP.i === i}">
          <span>${hm(t.t0)}</span><span>${esc(place(t.a))} ← ${esc(place(t.b))}</span><span class="km">${nf(kmOf(t))} ק״מ</span>${TAG(t)}</button>`).join("") : ""}</div>`;
    }).join("");
    box.querySelectorAll(".day>button").forEach(b => b.onclick = () => { OPENDAY = OPENDAY === b.dataset.d ? "" : b.dataset.d; SELTRIP = null; detail(); });
    box.querySelectorAll(".trip").forEach(b => b.onclick = () => {
      const [d, i] = b.dataset.i.split("|"); SELTRIP = { day: d, i: +i }; detail();
      if (innerWidth < 900) $("#map").scrollIntoView({ behavior: "smooth" });
    });
    const L = OPENDAY && byDay.get(OPENDAY) ? byDay.get(OPENDAY).sort((a, b) => a.t0 - b.t0) : [];
    if (!SELTRIP && L.length) { const i = Math.max(0, L.findIndex(t => excess(t) > 0)); SELTRIP = { day: OPENDAY, i }; box.querySelector(`[data-i="${OPENDAY}|${i}"]`)?.setAttribute("aria-current", "true"); }
    drawMap(SELTRIP && byDay.get(SELTRIP.day) ? byDay.get(SELTRIP.day)[SELTRIP.i] : null);
  }

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
  const VERD = { match: ["ok", "תואם"], op: ["mid", "גוגל: המפעיל צודק"], ours: ["mid", "גוגל: הניתוב שלנו צודק"], third: ["bad", "פער, לבדיקה פרטנית"], pending: ["mid", "פער, ממתין לגוגל"], "n/a": ["nd", "אין השוואה"] };
  async function drawMap(t) {
    const info = $("#mapInfo"), my = ++drawn;
    if (!t) { info.innerHTML = ""; $("#mapLeg").innerHTML = ""; if (lay) lay.clearLayers(); return; }
    const gap = t.op_km != null && t.our_km != null ? Math.abs(t.op_km - t.our_km) : null, v = VERD[t.verdict] || VERD["n/a"];
    info.innerHTML = `<table><tr><td>ק״מ לפי המפעיל</td><td>${nf(t.op_km)}</td></tr><tr><td>ק״מ לפי הניתוב שלנו</td><td>${nf(t.our_km)}</td></tr>${t.g_km != null ? `<tr><td>ק״מ לפי גוגל</td><td>${nf(t.g_km)}</td></tr>` : ""}</table>
      <div class="foot"><span class="tag ${v[0]}">${v[1]}${gap != null ? ` (פער ${nf(Math.round(gap * 10) / 10)} ק״מ)` : ""}</span><span>סידור ${esc(t.sidur)} · רכב ${esc(t.veh)}${t.end_src === "unresolved" ? " · קצה לא ידוע" : ""}</span></div>`;
    $("#mapLeg").innerHTML = `<span><i class="ln"></i> הניתוב שלנו</span><span>${esc(place(t.a))} ← ${esc(place(t.b))}</span>`;
    try { await leaflet(); } catch { info.insertAdjacentHTML("beforeend", `<div class="msg err">המפה לא נטענה</div>`); return; }
    if (my !== drawn) return;
    if (!map) {
      map = L.map("map", { zoomControl: true, attributionControl: true }); lay = L.layerGroup().addTo(map);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
    }
    lay.clearLayers();
    if (!t.a || !t.b) { map.setView([31.78, 35.2], 12); return; }
    const A = [t.a.lat, t.a.lon], B = [t.b.lat, t.b.lon];
    L.circleMarker(A, { radius: 8, color: "#2E9E4F", fillOpacity: 1 }).bindTooltip(place(t.a), { permanent: true, direction: "top" }).addTo(lay);
    L.circleMarker(B, { radius: 8, color: "#C62828", fillOpacity: 1 }).bindTooltip(place(t.b), { permanent: true, direction: "top" }).addTo(lay);
    map.fitBounds([A, B], { padding: [40, 40] });
    try {
      const pts = await YMAP.osrmLine(A, B); if (my !== drawn) return;
      L.polyline(pts, { color: "#E8871E", weight: 5 }).addTo(lay); map.fitBounds(L.latLngBounds(pts).extend(A).extend(B), { padding: [30, 30] });
    } catch { L.polyline([A, B], { color: "#E8871E", weight: 3, dashArray: "4 6" }).addTo(lay); }
  }

  // ---- other tabs (Task 7) ----
  function tab(id) {
    ["Excess", "Sid", "Gap", "Les"].forEach(k => { const on = "t" + k === id; $("#t" + k).setAttribute("aria-selected", on); $("#p" + k).hidden = !on; });
    if (window.PVA_TABS && window.PVA_TABS[id]) window.PVA_TABS[id](DAYS, { esc, nf, hm, dlabel, TAG, place, kmOf });
  }
  document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => tab(b.id));

  async function load() {
    const f = $("#dFrom").value, t = $("#dTo").value; if (!f || !t) return;
    say("טוען…");
    try { DAYS = (await rpc("get_pva", { p_operator: OP.id, p_from: f, p_to: t })) || []; }
    catch (e) { say("הטעינה נכשלה: " + e.message, true); return; }
    say(DAYS.length ? "" : "אין נתונים לתקופה הזו");
    SEL = null; OPENDAY = null; SELTRIP = null; cards(); rank();
    const cur = document.querySelector(".tabs [aria-selected=true]").id; if (cur !== "tExcess") tab(cur);
  }

  // local build -> database: platform admin, on localhost only (pipeline/cache is never deployed)
  async function loadLocal() {
    const f = new Date($("#dFrom").value + "T12:00:00"), t = new Date($("#dTo").value + "T12:00:00"); let n = 0;
    for (let d = f; d <= t; d = new Date(d.getTime() + 864e5)) {
      const day = d.toISOString().slice(0, 10);
      const r = await fetch(`pipeline/cache/pva_${day}.json`, { cache: "no-store" }); if (!r.ok) continue;
      say(`שומר את ${day}…`);
      try { await rpc("put_pva", { p_operator: OP.id, p_day: day, p_payload: await r.json() }); n++; } catch (e) { say(`השמירה של ${day} נכשלה: ${e.message}`, true); return; }
    }
    say(n ? `נשמרו ${n} ימים` : "לא נמצאו ימים בנויים בתקופה"); if (n) load();
  }

  $("#gDrv").onclick = () => { GROUP = "drv"; $("#gDrv").className = "on"; $("#gVeh").className = ""; $("#gDrv").setAttribute("aria-pressed", true); $("#gVeh").setAttribute("aria-pressed", false); SEL = null; OPENDAY = null; SELTRIP = null; rank(); };
  $("#gVeh").onclick = () => { GROUP = "veh"; $("#gVeh").className = "on"; $("#gDrv").className = ""; $("#gVeh").setAttribute("aria-pressed", true); $("#gDrv").setAttribute("aria-pressed", false); SEL = null; OPENDAY = null; SELTRIP = null; rank(); };
  $("#bLoad").onclick = load; $("#bLocal").onclick = loadLocal;

  (async () => {
    if (!SES) { say(""); $("main").innerHTML = `<div class="empty">צריך להיכנס קודם. <a href="index.html">כניסה לדשבורד</a></div>`; return; }
    try { await access(); } catch (e) { say("אין חיבור: " + e.message, true); return; }
    if (!OP || !allowed()) { $("main").innerHTML = `<div class="empty">אין לך הרשאה למסך הזה. הוא פתוח לעורכים ומעלה.</div>`; $("#cards").hidden = true; return; }
    $("#sub").textContent = `${OP.name} · קווים עירוניים`; document.title = `יאללה־סע · תכנון מול ביצוע · ${OP.name}`;
    if (OP.logo_url) { $("#opLogo").innerHTML = `<img src="${esc(OP.logo_url)}" alt="${esc(OP.name)}">`; $("#opLogo").hidden = false; }
    $("#bLocal").hidden = !(PLATFORM && /^(localhost|127\.0\.0\.1)$/.test(location.hostname));
    let days = []; try { days = (await rpc("pva_days", { p_operator: OP.id })) || []; } catch { }
    const last = days.length ? days[days.length - 1] : new Date().toISOString().slice(0, 10);
    const first = days.length ? days[Math.max(0, days.length - 7)] : last;
    $("#dFrom").value = first; $("#dTo").value = last;
    if (days.length) load(); else say("עדיין אין ימים שמורים");
  })();
})();
