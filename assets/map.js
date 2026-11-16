/* Map dialog shared by the schedule rows and the route warnings (Leaflet 1.9.4, self-hosted in assets/vendor/leaflet,
 * OSM tiles). YMAP.open({title, info, actions}) -> ctl: ctl.line(coords, {color, dash, label}), ctl.point(p, {label, fill}),
 * ctl.fit(points), ctl.info(html), ctl.status(text). Native <dialog> (Esc closes, focus stays inside while open), RTL.
 * Also: polyline decode/encode (OSRM "polyline" geometry, precision 5) and osrmLine(a, b, opt) -> [[lat,lon]...]. */
(function (root) {
  "use strict";
  let dlg = null, map = null, lay = null, loading = null, legend = [];
  const V = (document.currentScript && (document.currentScript.src.split("?v=")[1] || "")) || "";
  const t = s => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
  function leaflet() {
    if (root.L) return Promise.resolve();
    const add = (el, prop, url) => new Promise((ok, bad) => { el[prop] = url; el.onload = ok; el.onerror = () => bad(new Error("leaflet")); document.head.appendChild(el); });
    const css = Object.assign(document.createElement("link"), { rel: "stylesheet" });
    return loading || (loading = Promise.all([add(css, "href", "assets/vendor/leaflet/leaflet.css?v=" + V), add(document.createElement("script"), "src", "assets/vendor/leaflet/leaflet.js?v=" + V)])
      .catch(e => { loading = null; throw e; }));  // the CSS must be in before the map is built, or no tiles show
  }
  function ensure() {
    if (dlg) return dlg;
    dlg = document.createElement("dialog"); dlg.id = "dlgMap"; dlg.className = "mapdlg"; dlg.setAttribute("aria-labelledby", "mapT");
    dlg.innerHTML = `<div class="maphd"><h3 id="mapT"></h3><button type="button" class="btn small" id="mapX">✕ סגירה</button></div>
      <div id="mapInfo" class="mapinfo" aria-live="polite"></div><div id="mapBox" class="mapbox" aria-label="מפה"></div>
      <div id="mapLeg" class="mapleg"></div><div id="mapAct" class="mapact"></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector("#mapX").onclick = () => dlg.close();
    // opened from another dialog (o.back): closing the map goes one step back to it
    dlg.addEventListener("close", () => { const f = back; back = null; if (f) f(); });
    dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
    return dlg;
  }
  const drawLegend = () => { dlg.querySelector("#mapLeg").innerHTML = legend.map(x =>
    `<span><i style="background:${x.color};${x.dash ? "background:repeating-linear-gradient(90deg," + x.color + " 0 6px,transparent 6px 10px)" : ""}"></i>${t(x.label)}</span>`).join(""); };
  // one controller per opened map: calls from an older map (a slow request finishing late) are ignored
  let gen = 0, back = null;
  function mk(my) { const ok = () => my === gen && dlg && dlg.open && map;
  const ctl = {
    line(coords, o = {}) { if (!ok() || !coords || coords.length < 2) return ctl;
      L.polyline(coords, { color: o.color || "#1F5FBF", weight: o.weight || 5, opacity: o.opacity || .85, dashArray: o.dash ? "8 8" : null }).addTo(lay);
      if (o.label) { legend.push({ color: o.color || "#1F5FBF", dash: !!o.dash, label: o.label }); drawLegend(); } return ctl; },
    point(p, o = {}) { if (!ok() || !p) return ctl;
      const m = L.circleMarker(p, { radius: o.r || 7, color: o.border || "#111", weight: 2, fillColor: o.fill || "#fff", fillOpacity: 1 }).addTo(lay);
      if (o.label) m.bindTooltip(t(o.label), { permanent: !!o.permanent, direction: "top" }); return ctl; },
    fit(pts) { if (!ok()) return ctl; const okp = (pts || []).filter(p => p && isFinite(p[0]) && isFinite(p[1]));
      if (okp.length) map.fitBounds(L.latLngBounds(okp), { padding: [28, 28], maxZoom: 16 }); return ctl; },
    info(html) { if (my !== gen) return ctl; dlg.querySelector("#mapInfo").innerHTML = html; return ctl; },
    status(text, err) { if (my !== gen) return ctl; let s = dlg.querySelector("#mapInfo .mapst"); if (!s) { s = document.createElement("div"); s.className = "mapst"; dlg.querySelector("#mapInfo").appendChild(s); }
      s.textContent = text || ""; s.style.color = err ? "var(--warn)" : ""; return ctl; },
    // pick points on the map: cb([lat, lon]) returns true to keep picking
    pick(cb) { if (!ok()) return ctl; const box = map.getContainer(); box.style.cursor = "crosshair";
      const h = e => { if (!cb([e.latlng.lat, e.latlng.lng])) { map.off("click", h); box.style.cursor = ""; } }; map.on("click", h); return ctl; },
    get open() { return ok(); },
  };
  return ctl; }
  async function open(o) {
    ensure(); legend = []; const my = ++gen, ctl = mk(my);
    dlg.querySelector("#mapT").textContent = o.title || "מפה";
    back = typeof o.back === "function" ? o.back : null;
    dlg.querySelector("#mapX").textContent = back ? "→ חזרה" : "✕ סגירה";
    dlg.querySelector("#mapInfo").innerHTML = o.info || ""; dlg.querySelector("#mapLeg").innerHTML = ""; dlg.querySelector("#mapAct").innerHTML = o.actions || "";
    if (!dlg.open) dlg.showModal();
    dlg.querySelector("#mapX").focus();
    try { await leaflet(); } catch { ctl.status("לא ניתן לטעון את רכיב המפה", true); return null; }
    if (my !== gen) return null;
    if (!map) {
      map = L.map(dlg.querySelector("#mapBox"), { zoomControl: true, attributionControl: true });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(map);
      lay = L.layerGroup().addTo(map);
    } else { lay.clearLayers(); map.off("click"); map.getContainer().style.cursor = ""; }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));  // the dialog has its size now
    if (my !== gen) return null;
    map.invalidateSize(); ctl.fit(o.fit || []);
    return ctl;
  }
  // Google/OSRM polyline (precision 5)
  function decode(s) { const out = []; let i = 0, lat = 0, lon = 0;
    while (i < s.length) { for (const k of [0, 1]) { let b, sh = 0, r = 0; do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
        const d = r & 1 ? ~(r >> 1) : r >> 1; if (k) lon += d; else lat += d; } out.push([lat / 1e5, lon / 1e5]); }
    return out; }
  function encode(pts) { let o = "", pl = 0, pn = 0; const e = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ""; while (v >= 32) { s += String.fromCharCode((32 | (v & 31)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
    for (const [la, lo] of pts) { const a = Math.round(la * 1e5), b = Math.round(lo * 1e5); o += e(a - pl) + e(b - pn); pl = a; pn = b; } return o; }
  async function osrmLine(a, b, o = {}) {
    const ll = p => `${(+p[1]).toFixed(6)},${(+p[0]).toFixed(6)}`;
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${ll(a)};${ll(b)}?overview=full&geometries=polyline${o.curb ? "&approaches=curb;curb" : ""}`);
    const j = await r.json(); if (!j.routes || !j.routes[0]) throw new Error("no route");
    return decode(j.routes[0].geometry);
  }
  root.YMAP = { open, decode, encode, osrmLine, close: () => dlg && dlg.close() };
})(typeof self !== "undefined" ? self : this);
