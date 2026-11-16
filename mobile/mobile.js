// ---- mobile layout (≤ 768px), approved design: dashboard-design/mobile-variant-B.webp (2026-11-16) ----
// Presentation only. It reuses the app's own state and functions (render, side, selectVehicle, loadDay, saveAll, undoAll,
// nDraft, canEdit, MODEL, branch / reinforcement helpers): no data logic is duplicated here. The desktop layout is untouched:
// every element added here has class m-only and is hidden above 768px (mobile/mobile.css).
(() => {
  const MQ = matchMedia("(max-width:768px)");
  const on = () => MQ.matches;
  const ICON = {
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h18l-7 8.5V19l-4 2v-8.5z"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    house: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/></svg>',
  };

  // ---- build the mobile-only elements once ----
  const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; };
  const top = el(`<section class="m-only" id="mTop" aria-label="סינון ותצוגה">
    <div class="m-days">
      <div class="m-chips" role="group" aria-label="יום">
        <button class="m-chip" id="mYest" type="button">אתמול</button><button class="m-chip" id="mToday" type="button">היום</button>
        <label class="m-date">${ICON.cal}<select id="mDay" aria-label="תאריך"></select></label>
      </div>
      <button class="m-filter" id="mFilter" type="button" aria-haspopup="dialog">${ICON.filter}<span>סינון</span><span id="mFn"></span></button>
    </div>
    <div class="m-tiles">
      <div class="m-tile"><span>רכבים</span><b id="mtV">–</b></div>
      <div class="m-tile"><span>נסיעות</span><b id="mtT">–</b></div>
      <div class="m-tile"><span>ק״מ ריקים</span><b id="mtE">–</b></div>
      <div class="m-tile"><span>ק״מ תגבור</span><b id="mtR">–</b></div>
    </div>
    <label class="m-search">${ICON.search}<input type="search" id="mQ" placeholder="חיפוש מספר רכב" aria-label="חיפוש מספר רכב" inputmode="numeric" autocomplete="off"></label>
    <div id="mList" role="list" aria-label="רכבים"></div>
  </section>`);
  const vbar = el(`<div class="m-only" id="mVehBar"><button type="button" id="mBack" aria-label="חזרה לרשימת הרכבים">${ICON.back}</button><h2 id="mVehTitle"></h2></div>`);
  const sheet = el(`<dialog class="m-only m-sheet" id="mSheet" aria-labelledby="mSheetT">
    <div class="m-grab" aria-hidden="true"></div><h3 id="mSheetT">סינון</h3>
    <div class="m-seg" id="mCls" role="group" aria-label="סוג שירות"></div>
    <label class="m-sel"><select id="mBr" aria-label="סניף"></select></label>
    <label class="m-sel"><select id="mSort" aria-label="מיון"></select></label>
    <button class="btn primary m-go" id="mGo" type="button">הצגת תוצאות</button>
  </dialog>`);
  const sbar = el(`<div class="m-only" id="mSave" hidden role="region" aria-label="שינויים שלא נשמרו">
    <span id="mSaveTxt" aria-live="polite"></span><button class="btn" id="mUndo" type="button">ביטול</button><button class="btn primary" id="mSaveBtn" type="button">שמירה</button></div>`);
  const toast = el(`<div class="m-only" id="mToast" role="status" hidden></div>`);
  const hdr = document.querySelector("body>header"), mainEl = document.querySelector("body>main");
  hdr.after(vbar); mainEl.before(top); document.body.append(sheet, sbar, toast);
  // the account menu gets the actions that live in the desktop toolbar (hidden on the phone)
  const menu = $("#meMenu");
  menu.insertAdjacentHTML("afterbegin", '<div class="m-only m-who" id="mWho"></div>');
  menu.insertAdjacentHTML("beforeend", '<button class="m-only" role="menuitem" data-mm="bSav">הצעות חיסכון</button><button class="m-only" role="menuitem" data-mm="bCtl" id="mCtl">חדר בקרה</button><select class="m-only" id="mOp" aria-label="מפעיל" hidden></select><button class="m-only" role="menuitem" data-mm="bEdit">יציאה</button>');
  menu.addEventListener("click", e => { const b = e.target.closest("[data-mm]"); if (!b) return; menu.hidden = true; $("#" + b.dataset.mm).click(); });
  $("#mOp").onchange = e => { const o = $("#opSel"); o.value = e.target.value; o.dispatchEvent(new Event("change")); };
  $("#who").addEventListener("click", () => {
    if (!on()) return;
    const w = $("#who").innerHTML.split("<br>"); $("#mWho").innerHTML = `<b>${w[0].replace(" ▾", "")}</b><span>${w[1] || ""}</span>`;
    $("#mCtl").hidden = $("#bCtl").hidden; const os = $("#opSel"); $("#mOp").hidden = os.hidden; $("#mOp").innerHTML = os.innerHTML; $("#mOp").value = os.value;
  }, true);

  // ---- day chips, search, filter sheet: they drive the desktop controls, so there is one state ----
  const fire = (id, ev) => $(id).dispatchEvent(new Event(ev));
  $("#mYest").onclick = () => $("#bYest").click();
  $("#mToday").onclick = () => $("#bToday").click();
  $("#mDay").onchange = e => { $("#day").value = e.target.value; fire("#day", "change"); };
  $("#mQ").oninput = e => { $("#q").value = e.target.value; $("#q").oninput(); };
  $("#mFilter").onclick = () => { drawSheet(); sheet.showModal(); };
  $("#mGo").onclick = () => sheet.close();
  sheet.addEventListener("click", e => { if (e.target === sheet) sheet.close(); }); // tap on the backdrop
  $("#mCls").onclick = e => { const b = e.target.closest("[data-cls]"); if (!b) return; $("#cls").value = b.dataset.cls; fire("#cls", "change"); drawSheet(); };
  // (#br / #sort call the original render directly, not the wrapped one: redraw the mobile view after them)
  $("#mBr").onchange = e => { $("#br").value = e.target.value; fire("#br", "change"); drawTop(); };
  $("#mSort").onchange = e => { $("#sort").value = e.target.value; fire("#sort", "change"); drawTop(); };
  function drawSheet() {
    $("#mCls").innerHTML = [...document.querySelectorAll("#cls option")].map(o => `<button type="button" class="${o.selected ? "on" : ""}" data-cls="${esc(o.value)}">${esc(o.textContent.replace(/^סוג: /, ""))}</button>`).join("");
    $("#mBr").innerHTML = $("#br").innerHTML; $("#mBr").value = $("#br").value;
    $("#mSort").innerHTML = $("#sort").innerHTML; $("#mSort").value = $("#sort").value;
  }

  // ---- vehicle list (cards with a mini timeline) ----
  const segsOf = (v, s) => {
    const out = [];
    for (const n of s.n) if (n.km >= 1) out.push([n.kind === "rein" ? "rein" : "dep", n.start, n.end]);
    for (const i of v.items) {
      if (i.kind === "trip") out.push([i.auto && autoSt(v, i) !== "rejected" ? "rein" : "svc", i.start, i.end]);
      else if (i.kind === "empty" && !i.overlap) {
        if (reinOf(v, i)) out.push(["rein", i.start, i.end]);
        else if (i.km >= 1) out.push(["emp", i.start, Math.min(i.end, i.start + Math.max(i.drive_min || 0, 3))]);
      }
    }
    return out;
  };
  const timeline = (v, s) => {
    const sg = segsOf(v, s); if (!sg.length) return "";
    const a = Math.min(...sg.map(x => x[1])), b = Math.max(...sg.map(x => x[2])), w = Math.max(b - a, 1);
    const bars = sg.map(([c, x, y]) => `<i class="m-${c}" style="left:${((x - a) / w * 100).toFixed(2)}%;width:${Math.max((y - x) / w * 100, 1.6).toFixed(2)}%"></i>`).join("");
    return `<div class="m-tl" aria-hidden="true"><span class="m-home">${ICON.house}</span><span class="m-track">${bars}</span><span class="m-home">${ICON.house}</span></div>`;
  };
  const LIMIT = 150; let shown = LIMIT, lastSig = "";
  function drawList() {
    const V = window.YS_VIEW; if (!V || !D) return;
    const sumOf = f => V.vsAll.reduce((t, [v, s]) => t + f(v, s), 0);
    $("#mtV").textContent = $("#cV").textContent; $("#mtT").textContent = $("#cT").textContent;
    $("#mtE").textContent = nf(Math.round(sumOf((v, s) => s.emp + s.nk)));
    $("#mtR").textContent = nf(Math.round(sumOf((v, s) => (s.rein || 0) + (s.nrein || 0))));
    const sig = D.day + "|" + V.vs.length; if (sig !== lastSig) { shown = LIMIT; lastSig = sig; }
    let h = "";
    for (const [v, s] of V.vs.slice(0, shown)) {
      const tot = s.emp + s.nk;
      h += `<button type="button" class="m-vc${v.veh === sel ? " sel" : ""}" role="listitem" data-v="${esc(v.veh)}" aria-label="רכב ${esc(v.veh)}, ${esc(v.cls)}, ${nf(tot)} ק״מ ריק">
        <span class="m-vmain"><span class="m-vtop"><b>${esc(v.veh)}</b><span class="badge ${v.cls === "עירוני" ? "urb" : "ic"}">${esc(v.cls)}</span>${brBadge(v)}</span>${timeline(v, s)}</span>
        <span class="m-vkm"><span>ריק</span><b>${nf(tot)}</b><span>ק״מ</span></span></button>`;
    }
    if (!V.vs.length) h = '<div class="empty-state">לא נמצאו רכבים</div>';
    else if (V.vs.length > shown) h += `<button type="button" class="btn m-more" id="mMore">עוד ${nf(Math.min(LIMIT, V.vs.length - shown))} רכבים (מתוך ${nf(V.vs.length - shown)})</button>`;
    $("#mList").innerHTML = h;
  }
  $("#mList").addEventListener("click", async e => {
    if (e.target.closest("#mMore")) { shown += LIMIT; drawList(); return; }
    const c = e.target.closest(".m-vc"); if (!c) return;
    if (await selectVehicle(c.dataset.v)) openVeh();
  });
  function drawTop() {
    if (!on()) return;
    const d = $("#day"); if ($("#mDay").dataset.sig !== d.innerHTML.length + "") { $("#mDay").innerHTML = d.innerHTML; $("#mDay").dataset.sig = d.innerHTML.length + ""; }
    $("#mDay").value = d.value;
    for (const [m, o] of [["#mYest", "#bYest"], ["#mToday", "#bToday"]]) { $(m).disabled = $(o).disabled; $(m).classList.toggle("on", $(o).classList.contains("on")); $(m).title = $(o).title; }
    if (document.activeElement !== $("#mQ")) $("#mQ").value = $("#q").value;
    const n = (cls ? 1 : 0) + ($("#br").value ? 1 : 0) + ($("#sort").value !== "veh" ? 1 : 0);
    $("#mFn").textContent = n ? `(${n})` : ""; $("#mFilter").classList.toggle("on", n > 0);
    drawList();
  }

  // ---- one vehicle: the app's own side panel, shown full screen ----
  let listY = 0, pushed = false;
  function openVeh() {
    if (!on() || document.body.classList.contains("m-veh")) return;
    listY = scrollY; document.body.classList.add("m-veh"); drawVehTitle(); scrollTo(0, 0);
    try { history.pushState({ mveh: 1 }, ""); pushed = true; } catch { pushed = false; }
  }
  function closeVeh(fromPop) {
    if (!document.body.classList.contains("m-veh")) return;
    document.body.classList.remove("m-veh"); BLKMODE = false; drawList(); scrollTo(0, listY);
    if (!fromPop && pushed) { pushed = false; history.back(); } else pushed = false;
  }
  addEventListener("popstate", () => { if (document.body.classList.contains("m-veh")) { pushed = false; closeVeh(true); } });
  $("#mBack").onclick = () => closeVeh(false);
  function drawVehTitle() { const h = $("#side h2"); $("#mVehTitle").textContent = h ? h.textContent : ""; }

  // ---- unsaved changes: sticky bar only while there are drafts ----
  function drawSave() {
    const n = typeof nDraft === "function" ? nDraft() : 0, show = on() && canEdit() && n > 0;
    sbar.hidden = !show; document.body.classList.toggle("m-saving", show);
    $("#mSaveTxt").textContent = n === 1 ? "שינוי אחד לא נשמר" : `${nf(n)} שינויים לא נשמרו`;
    $("#mSaveBtn").disabled = $("#bSave").disabled; $("#mUndo").disabled = $("#bUndo").disabled;
  }
  $("#mSaveBtn").onclick = () => saveAll();
  $("#mUndo").onclick = () => $("#bUndo").click();
  let tt; const showToast = (t, err) => { if (!on()) return; toast.textContent = t; toast.className = "m-only" + (err ? " err" : ""); toast.hidden = !t; clearTimeout(tt); if (t && !/^שומר/.test(t)) tt = setTimeout(() => toast.hidden = true, err ? 8000 : 3500); };
  new MutationObserver(() => { const m = $("#saveMsg"); showToast(m.textContent, m.classList.contains("err")); }).observe($("#saveMsg"), { childList: true, characterData: true, subtree: true });

  // ---- tables in dialogs (settings, control room, block editor, savings) become cards: each cell gets its column name ----
  const labelTables = root => root.querySelectorAll("table.ed").forEach(t => {
    const hr = t.querySelector("thead tr") || [...t.querySelectorAll("tr")].find(tr => tr.children.length > 1 && [...tr.children].every(c => c.tagName === "TH"));
    if (!hr) return;
    const hs = [...hr.children].map(th => th.textContent.trim());
    hr.classList.add("m-hdr"); t.classList.add("m-cards");
    t.querySelectorAll("tbody tr, tr").forEach(tr => [...tr.children].forEach((td, i) => { if (td.tagName === "TD" && hs[i] && td.dataset.l !== hs[i]) td.dataset.l = hs[i]; }));
  });
  const mo = new MutationObserver(recs => { if (!on()) return; const seen = new Set(); recs.forEach(r => { const d = r.target.closest ? r.target.closest("dialog") : null; if (d && !seen.has(d)) { seen.add(d); labelTables(d); } }); });
  document.querySelectorAll("dialog").forEach(d => mo.observe(d, { childList: true, subtree: true }));

  // ---- hook the app's renderers (function declarations are globals: internal calls go through these wrappers) ----
  const wrap = (name, after) => { const f = window[name]; if (typeof f !== "function") return; window[name] = function (...a) { const r = f.apply(this, a); try { after(); } catch (e) { console.warn("mobile", name, e); } return r; }; };
  wrap("render", drawTop);
  wrap("side", () => { if (on()) drawVehTitle(); });
  wrap("drawSaveBar", drawSave);
  wrap("loadDay", () => { if (on()) closeVeh(false); });
  MQ.addEventListener("change", () => { if (!on()) { document.body.classList.remove("m-veh", "m-saving"); sheet.open && sheet.close(); } else { drawTop(); } drawSave(); });
  drawSave();
})();
