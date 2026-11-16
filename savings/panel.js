/* Savings panel ("הצעות חיסכון"): rule editor (operator defaults + per-line overrides), run, results, detail, CSV.
 * Plain script, no build. Load after savings/engine.js:
 *   <link rel="stylesheet" href="savings/panel.css"><script src="savings/engine.js"></script><script src="savings/panel.js"></script>
 *   const ui = SavingsPanel.mount(document.getElementById("savings"), host);
 *
 * host (supplied by index.html; nothing here reads the app's globals):
 *   operatorId                       current operator uuid
 *   canEdit() -> bool                editor / admin / platform admin
 *   days() -> ["YYYY-MM-DD", ...]    built days         currentDay() -> "YYYY-MM-DD"
 *   loadDay(day) -> Promise<day JSON | null>            (decrypted in the page)
 *   roadEntries() -> [[roadKey, km, min], ...]          the shared road cache as loaded now
 *   fetchRoad(pairs [[a,b]], onProgress(done,total)) -> Promise   fills road_cache (cache -> OSRM -> upsert)
 *   branchOf(veh) -> string   depotOf(veh) -> [lat,lon] | null   dcp() -> settings.driver_change_points
 *   getRows(table, query) -> Promise<rows>   rpc(fn, args) -> Promise
 *   onDraft(dirty:boolean)?          the app's unsaved-changes indicator (stand-alone mode)
 *   getDraftRules() / setDraftRules(ruleset|null)?  the app's draft model: when given, rule edits are app drafts
 *                                    saved by the app's own "שמירה" (it calls rpc save_rule_set); the panel has no save button.
 *                                    After the app saves: ui.reloadRules(); after it drops drafts: ui.syncDraft().
 *   getBlocks(day)?                  returns the day with manual block edits applied (block_edits); runs in the page
 *   workerUrl?                       default "savings/worker.js"
 */
(function (root) {
  "use strict";
  const E = root.SavingsEngine;
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = o => JSON.parse(JSON.stringify(o));
  const fmt = E.fmt, num = x => (Math.round(x * 10) / 10).toLocaleString("he-IL");
  const signed = n => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n);
  const ROAD_CAP = 600; // most new links fetched from OSRM per run (the rest stay labelled "הערכה")

  function mount(el, host) {
    const S = {
      saved: { operator: {}, lines: {} }, draft: { operator: {}, lines: {} }, meta: {},
      tab: "list", result: null, sel: null, busy: "", err: "", detail: null, lines: [], showRules: false, addLine: "",
    };
    const days = new Map();
    let worker = null, seq = 0;
    const pending = new Map();

    el.classList.add("sv");
    el.setAttribute("dir", "rtl");
    el.addEventListener("click", onClick);
    el.addEventListener("change", onChange);
    el.addEventListener("input", onInput);
    el.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("tr[data-act]")) { e.preventDefault(); e.target.click(); } });

    // ------------------------------------------------------------ data
    async function loadRules() {
      try {
        const rows = await host.getRows("rule_sets", `select=scope,line_key,rules,updated_at&operator_id=eq.${host.operatorId}`) || [];
        const rs = { operator: {}, lines: Object.create(null) }; // no prototype keys from line_key (L10)
        for (const r of rows) {
          if (r.scope === "operator") rs.operator = r.rules || {};
          else if (r.scope === "line" && r.line_key) rs.lines[r.line_key] = r.rules || {};
          S.meta[r.scope + ":" + (r.line_key || "")] = r.updated_at;
        }
        const n = E.normalizeRuleset(rs);
        // keep only what differs from the defaults at operator level, overrides as given
        S.saved = { operator: diffDefaults(n.operator), lines: n.lines };
        S.draft = appDraft() || clone(S.saved);
      } catch (e) { S.err = "טעינת הכללים נכשלה: " + (e.message || e); }
    }
    const diffDefaults = op => Object.fromEntries(Object.entries(op).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(E.DEFAULT_RULES[k])));
    const dirty = () => JSON.stringify(S.draft) !== JSON.stringify(S.saved);
    async function getDay(d) {
      // manual block edits are applied here, in the page (functions cannot be sent to the worker)
      // raw files are cached; block edits are applied at every run (they may change between runs)
      if (!days.has(d)) days.set(d, await host.loadDay(d));
      const raw = days.get(d);
      return raw && host.getBlocks ? host.getBlocks(raw) || raw : raw;
    }
    // stability candidates: up to 4 nearest same-weekday days + the day before and after (the engine picks)
    function compareCandidates(day) {
      const all = host.days().filter(d => d !== day), n = d => Date.parse(d + "T12:00:00Z") / 864e5, d0 = n(day);
      const same = all.filter(d => ((n(d) - d0) % 7 + 7) % 7 === 0).sort((a, b) => Math.abs(n(a) - d0) - Math.abs(n(b) - d0)).slice(0, 4);
      const adj = all.filter(d => Math.abs(n(d) - d0) === 1);
      return [...new Set([...same, ...adj])];
    }
    function callWorker(msg) {
      return new Promise((resolve, reject) => {
        if (!worker) {
          try { worker = new Worker(host.workerUrl || "savings/worker.js"); }
          catch (e) { // file:// or blocked: run in the page (slower UI, same result)
            try { resolve(E.run(Object.assign({}, msg, { road: roadFn(msg.road), branchOf: v => msg.branches[v] || "", depotOf: v => msg.depots[v] || null }))); }
            catch (e2) { reject(e2); }
            return;
          }
          worker.onmessage = e => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error)); };
          worker.onerror = e => { for (const p of pending.values()) p.reject(new Error(e.message || "שגיאה בחישוב")); pending.clear(); worker = null; };
        }
        const id = ++seq;
        pending.set(id, { resolve, reject });
        worker.postMessage(Object.assign({ id, cmd: "run" }, msg));
      });
    }
    const roadFn = entries => { const m = new Map((entries || []).map(r => [r[0], { km: r[1], min: r[2] }])); return (a, b) => m.get(E.roadKey(a, b)) || null; };
    async function message(extra) {
      const day = host.currentDay();
      const d = await getDay(day);
      if (!d) throw new Error("אין נתונים ליום " + day);
      const others = (await Promise.all(compareCandidates(day).map(getDay))).filter(Boolean);
      const branches = {}, depots = {};
      for (const v of d.vehicles || []) {
        branches[v.veh] = host.branchOf ? host.branchOf(v.veh) || "" : "";
        const dp = host.depotOf ? host.depotOf(v.veh) : null; if (dp) depots[v.veh] = dp;
      }
      S.lines = [...new Set([].concat(...(d.vehicles || []).map(v => (v.items || []).filter(i => i.kind === "trip").map(i => String(i.line)))))]
        .sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0) || a.localeCompare(b));
      return Object.assign({ day: d, others, ruleset: S.draft, road: host.roadEntries ? host.roadEntries() : [], branches, depots,
        dcp: host.dcp ? host.dcp() || [] : [] }, extra || {});
    }
    async function run() {
      if (S.busy) return;
      S.err = ""; S.sel = null; S.detail = null; S.tab = "list";
      try {
        S.busy = "טוען את נתוני היום והימים להשוואה…"; render();
        const msg = await message();
        S.busy = "מחשב הצעות…"; render();
        let r = await callWorker(msg);
        S.result = r; render();
        const R = E.normalizeRuleset(S.draft);
        if (R.operator.distance_source === "road" && r.missingRoad.length && host.fetchRoad) {
          const pairs = r.missingRoad.slice(0, ROAD_CAP);
          S.busy = `משלים מרחקי כביש: 0 מתוך ${pairs.length}`; render();
          await host.fetchRoad(pairs, (done, total) => { S.busy = `משלים מרחקי כביש: ${done} מתוך ${total}`; renderBusy(); });
          S.busy = "מחשב מחדש לפי מרחקי כביש…"; render();
          r = await callWorker(Object.assign(msg, { road: host.roadEntries() }));
          S.result = r;
        }
      } catch (e) { S.err = "החישוב נכשל: " + (e.message || e); }
      S.busy = ""; render();
    }
    async function explainPair(a, b) {
      if (S.busy) return;
      a = String(a || "").trim(); b = String(b || "").trim();
      if (!a || !b || a === b) { S.err = "צריך שני מספרי רכב שונים"; render(); return; }
      S.err = ""; S.busy = `בודק את ${a} ו־${b}…`; render();
      try {
        const msg = await message({ pair: { A: a, B: b }, limits: { suggestions: 1, nearMisses: 1 } });
        let r = await callWorker(msg);
        const best = () => r.suggestions[0] || r.nearMisses[0] || null;
        if (best() && best().distance === "estimate" && host.fetchRoad && r.missingRoad.length) {
          await host.fetchRoad(r.missingRoad.slice(0, 50), () => {});
          r = await callWorker(Object.assign(msg, { road: host.roadEntries() }));
        }
        S.detail = best();
        S.tab = "detail";
        if (!S.detail) S.err = `לא נמצאה אפשרות החלפה בזמנים בין ${a} ל־${b} (אין חלון זמן משותף שבו שניהם פנויים, או שאחד מהם לא קיים ביום הזה).`;
      } catch (e) { S.err = "הבדיקה נכשלה: " + (e.message || e); }
      S.busy = ""; render();
    }
    async function save() {
      if (!host.canEdit() || !dirty()) return;
      const R = E.normalizeRuleset(S.draft);
      S.busy = "שומר כללים…"; render();
      try {
        await host.rpc("save_rule_set", { p_operator: host.operatorId, p_operator_rules: diffDefaults(R.operator), p_lines: R.lines });
        await loadRules();
        S.err = ""; S.okMsg = "הכללים נשמרו";
      } catch (e) { S.err = "השמירה נכשלה: " + (e.message || e); }
      S.busy = ""; render(); notifyDraft();
    }
    function exportCSV() {
      if (!S.result) return;
      const blob = new Blob([E.toCSV(S.result)], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `הצעות-חיסכון-${S.result.day}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    const appMode = typeof host.setDraftRules === "function";
    function appDraft() { const d = appMode && host.getDraftRules ? host.getDraftRules() : null; return d ? clone(d) : null; }
    const notifyDraft = () => { if (appMode) host.setDraftRules(dirty() ? clone(S.draft) : null); else if (host.onDraft) host.onDraft(dirty()); };

    // ------------------------------------------------------------ events
    function onClick(e) {
      const t = e.target.closest("[data-act]"); if (!t || t.disabled) return;
      const a = t.dataset.act, R = S.draft;
      if (a === "run") run();
      else if (a === "csv") exportCSV();
      else if (a === "rules") { S.showRules = !S.showRules; render(); }
      else if (a === "tab") { S.tab = t.dataset.tab; render(); }
      else if (a === "open") { const id = t.dataset.id; S.detail = [...S.result.suggestions, ...S.result.nearMisses].find(s => s.id === id); S.tab = "detail"; render(); el.querySelector(".sv-detail")?.scrollIntoView({ block: "start" }); }
      else if (a === "back") { S.tab = S.detail && !S.detail.ok ? "miss" : "list"; S.detail = null; render(); }
      else if (a === "why") explainPair(el.querySelector("#svPA").value, el.querySelector("#svPB").value);
      else if (a === "save") save();
      else if (a === "revert") { S.draft = clone(S.saved); render(); notifyDraft(); }
      else if (a === "reset-op") { delete R.operator[t.dataset.key]; touched(); }
      else if (a === "reset-all") { R.operator = {}; touched(); }
      else if (a === "del-line") { delete R.lines[t.dataset.line]; touched(); }
      else if (a === "add-line") {
        const ln = String(el.querySelector("#svAddLine").value || "").trim();
        if (ln && !R.lines[ln]) { R.lines[ln] = {}; touched(); }
      }
      else if (a === "add-win") { const tgt = winTarget(t); tgt.blocked_windows = (tgt.blocked_windows || effective(t.dataset.line, "blocked_windows").slice()).concat([{ from: "13:00", to: "16:00" }]); touched(); }
      else if (a === "del-win") { const tgt = winTarget(t); const w = (tgt.blocked_windows || []).slice(); w.splice(+t.dataset.i, 1); tgt.blocked_windows = w; touched(); }
    }
    const winTarget = t => t.dataset.line ? S.draft.lines[t.dataset.line] : S.draft.operator;
    function onChange(e) {
      const t = e.target;
      if (t.dataset.ov != null) { // inherit / override toggle on a line
        const o = S.draft.lines[t.dataset.line], k = t.dataset.ov;
        if (t.checked) o[k] = clone(effective(null, k)); else delete o[k];
        touched(); return;
      }
      if (t.dataset.key) { setVal(t); touched(); }
    }
    function onInput(e) { const t = e.target; if (t.dataset.key && t.type !== "checkbox" && t.tagName !== "SELECT" && !t.dataset.win) { setVal(t); notifyDraft(); markDirty(); } }
    function setVal(t) {
      const k = t.dataset.key, m = E.RULES_META.find(x => x.key === k), tgt = t.dataset.line ? S.draft.lines[t.dataset.line] : S.draft.operator;
      if (t.dataset.win != null) { const w = (tgt.blocked_windows || []).map(x => Object.assign({}, x)); w[+t.dataset.win][t.dataset.end] = t.value; tgt.blocked_windows = w; return; }
      if (m.type === "bool") tgt[k] = t.checked;
      else if (m.type === "num") { if (t.value === "" && m.nullable) tgt[k] = null; else if (t.value !== "" && Number.isFinite(+t.value)) tgt[k] = +t.value; }
      else tgt[k] = t.value;
    }
    function touched() { S.okMsg = ""; render(); notifyDraft(); }
    function markDirty() { const b = el.querySelector(".sv-draft"); if (b) b.hidden = !dirty(); const s = el.querySelector("[data-act=save]"); if (s) s.disabled = !dirty() || !host.canEdit(); }
    function effective(line, k) {
      const R = E.normalizeRuleset(S.draft);
      return line && R.lines[line] && k in R.lines[line] ? R.lines[line][k] : R.operator[k];
    }

    // ------------------------------------------------------------ render
    function renderBusy() { const b = el.querySelector(".sv-busy"); if (b) b.textContent = S.busy; }
    function render() {
      const r = S.result, ro = !host.canEdit();
      el.innerHTML = `
        <div class="sv-head">
          <div><h2>הצעות חיסכון בנסיעות ריקות</h2>
            <div class="muted">החלפת קטעי עבודה בין שני אוטובוסים בלי לשנות את לוח הזמנים. כל סידור מתחיל ומסתיים כמו היום.</div></div>
          <div class="sv-actions">
            <button class="btn ${S.showRules ? "on" : ""}" data-act="rules" aria-expanded="${S.showRules}">כללים${dirty() ? " •" : ""}</button>
            <button class="btn primary" data-act="run" ${S.busy ? "disabled" : ""}>הרצה על ${esc(fmtDay(host.currentDay()))}</button>
            <button class="btn" data-act="csv" ${!r || ro ? "disabled" : ""} title="${ro ? "ייצוא זמין לעורכים ומנהלים" : "קובץ CSV לאקסל"}">ייצוא CSV</button>
          </div>
        </div>
        <div class="sv-busy" role="status" aria-live="polite" ${S.busy ? "" : "hidden"}>${esc(S.busy)}</div>
        ${S.err ? `<div class="msg err" role="alert">${esc(S.err)}</div>` : ""}
        ${S.okMsg ? `<div class="msg ok" role="status">${esc(S.okMsg)}</div>` : ""}
        ${S.showRules ? rulesHtml(ro) : ""}
        ${r ? summaryHtml(r) : `<div class="empty-state sv-empty">לחיצה על "הרצה" מחשבת הצעות ליום שנבחר, לפי הכללים${dirty() ? " (כולל הטיוטה שלא נשמרה)" : ""}.</div>`}
        ${r || S.detail ? bodyHtml(r) : ""}
        <div class="sv-why">
          <b>למה לא?</b> <span class="muted">בדיקת שני רכבים מסוימים:</span>
          <span class="sv-whyin"><input id="svPA" class="sv-in" inputmode="numeric" placeholder="רכב א'" aria-label="רכב א'">
          <input id="svPB" class="sv-in" inputmode="numeric" placeholder="רכב ב'" aria-label="רכב ב'">
          <button class="btn small" data-act="why" ${S.busy ? "disabled" : ""}>בדיקה</button></span>
        </div>`;
    }
    const fmtDay = d => d ? d.slice(8, 10) + "." + d.slice(5, 7) : "";
    function summaryHtml(r) {
      const est = r.suggestions.filter(s => s.distance === "estimate").length;
      return `<div class="cards sv-cards">
        <div class="card"><div class="k">הצעות שעומדות בכל הכללים</div><div class="v">${r.suggestions.length}</div><div class="s">${est ? `${est} לפי הערכת מרחק` : "מרחקי כביש"}</div></div>
        <div class="card"><div class="k">חיסכון אפשרי ביום</div><div class="v">${num(r.plan.saving_km)}</div><div class="s">ק"מ · ${r.plan.ids.length} הצעות בלי רכב משותף</div></div>
        <div class="card"><div class="k">נפסלו בהפרש קטן</div><div class="v">${r.nearMisses.length}</div><div class="s">ראו "למה לא"</div></div>
        <div class="card"><div class="k">ימים להשוואת יציבות</div><div class="v sv-small">${r.compareDays.length ? r.compareDays.map(fmtDay).join(" · ") : "אין"}</div><div class="s">${r.stats.vehicles} רכבים · ${(r.stats.ms / 1000).toFixed(1)} שנ'</div></div>
      </div>`;
    }
    function bodyHtml(r) {
      const tabs = r ? `<div class="tabs" role="tablist">
        <button role="tab" data-act="tab" data-tab="list" class="${S.tab === "list" ? "on" : ""}" aria-selected="${S.tab === "list"}">מוצעות (${r.suggestions.length})</button>
        <button role="tab" data-act="tab" data-tab="miss" class="${S.tab === "miss" ? "on" : ""}" aria-selected="${S.tab === "miss"}">למה לא (${r.nearMisses.length})</button>
        ${S.detail ? `<button role="tab" data-act="tab" data-tab="detail" class="${S.tab === "detail" ? "on" : ""}" aria-selected="${S.tab === "detail"}">פירוט</button>` : ""}
      </div>` : "";
      let body = "";
      if (S.tab === "detail" && S.detail) body = detailHtml(S.detail);
      else if (r && S.tab === "miss") body = listHtml(r.nearMisses, true);
      else if (r) body = listHtml(r.suggestions, false);
      const de = r ? r.skipped.filter(x => x.dataError) : [], few = r ? r.skipped.length - de.length : 0;
      const skipped = r && r.skipped.length ? `<details class="hint sv-skipped"><summary>${de.length ? `${de.length} רכבים לא נבדקו: שגיאת נתונים` : ""}${de.length && few ? " · " : ""}${few ? `${few} עם פחות משתי נסיעות` : ""}</summary>
        <ul>${de.map(x => `<li><b>${esc(x.veh)}</b>: ${esc(x.detail || "")}</li>`).join("")}</ul></details>` : "";
      return `<div class="panel sv-body">${tabs}<div class="sv-scroll">${body}${S.tab !== "detail" ? skipped : ""}</div></div>`;
    }
    function listHtml(list, miss) {
      if (!list.length) return `<div class="empty-state">${miss ? "אין הצעות שנפסלו בהפרש קטן." : "לא נמצאו הצעות שעומדות בכל הכללים. אפשר לראות ב\"למה לא\" מה חסם."}</div>`;
      return `<table class="ed sv-table"><thead><tr>
        <th>${miss ? "" : "#"}</th><th>רכבים</th><th>טווח</th><th>ריק היום</th><th>בהצעה</th><th>חיסכון</th><th>מרווח מינ'</th><th>יציבות</th>${miss ? "<th>נחסם על ידי</th>" : "<th>מרחק</th>"}<th></th>
        </tr></thead><tbody>${list.map(s => `<tr class="pickable" data-act="open" data-id="${esc(s.id)}" tabindex="0">
        <td>${miss ? "" : s.rank}</td>
        <td>${vehHtml(s)}</td>
        <td class="t">${esc(s.spanText)}</td>
        <td>${num(s.today_km)}</td><td>${num(s.proposed_km)}</td>
        <td><b>${num(s.saving_km)}</b> ק"מ</td>
        <td>${s.min_margin} דק'</td>
        <td>${s.stability ? `${s.stability.hits}/${s.stability.n}` : "<span class=muted>לא נבדקה</span>"}</td>
        ${miss ? `<td>${s.failed.map(f => `<span class="sv-chip bad">${esc(E.RULE_LABEL[f] || f)}</span>`).join(" ")}</td>`
               : `<td>${s.distance === "road" ? "כביש" : `<span class="sv-chip warn" title="חלק מהמרחקים הם הערכה">הערכה</span>`}</td>`}
        <td><button class="btn small" data-act="open" data-id="${esc(s.id)}">פירוט</button></td></tr>`).join("")}</tbody></table>`;
    }
    const vehHtml = s => `<span class="sv-veh">${esc(s.A)}</span> ↔ <span class="sv-veh">${esc(s.B)}</span>${s.type === "tail" ? ` <span class="sv-chip warn">סוף יום</span>` : ""}`;
    function detailHtml(s) {
      const st = s.stability;
      return `<div class="sv-detail">
        <div class="sv-dhead"><button class="btn small" data-act="back">חזרה לרשימה</button>
          <h3>${s.ok ? "הצעה" : "לא מוצע"}: ${vehHtml(s)} · ${esc(s.spanText)}</h3></div>
        <div class="sv-kpis">
          <div><span>ריק היום</span><b>${num(s.today_km)} ק"מ</b></div>
          <div><span>ריק בהצעה</span><b>${num(s.proposed_km)} ק"מ</b></div>
          <div class="${s.saving_km > 0 ? "good" : "bad"}"><span>חיסכון</span><b>${num(s.saving_km)} ק"מ</b></div>
          <div><span>מקור מרחק</span><b>${s.distance === "road" ? "כביש" : "הערכה (מסומן)"}</b></div>
        </div>
        <p class="sv-plain">${plain(s)}</p>
        ${timelineHtml(s)}
        <h4>נקודות ההחלפה</h4>
        <table class="ed sv-table"><thead><tr><th>רכב</th><th>מקום</th><th>מגיע</th><th>יוצא</th><th>נסיעה ריקה בהצעה</th><th>היום</th><th>מרווח נטו</th><th>המתנה נוספת</th></tr></thead><tbody>
        ${s.junctions.map(j => `<tr>
          <td>${esc(j.veh)}</td><td>${esc(j.place)}${j.placeTo && j.placeTo !== j.place ? ` ← ${esc(j.placeTo)}` : ""}${j.dcp ? ` <span class="sv-chip">${esc(j.dcp)}</span>` : ""}</td>
          <td class="t">${j.arriveText}</td><td class="t">${j.departText}</td>
          <td>${num(j.km)} ק"מ · ${j.min} דק'${j.src === "est" ? ` <span class="sv-chip warn">הערכה</span>` : ""}</td>
          <td>${num(j.todayKm)} ק"מ</td>
          <td class="${j.ok.margin ? "" : "sv-bad"}">${j.margin} דק' <span class="muted">(מינ' ${j.rule.min_margin_min})</span></td>
          <td class="${j.ok.added && j.ok.wait ? "" : "sv-bad"}">${signed(j.addedWait)} דק' <span class="muted">(${j.waitToday}→${j.waitNew})</span></td></tr>`).join("")}
        </tbody></table>
        ${s.depot ? `<div class="hint">חזרה לחניון בסוף היום: היום ${num(s.depot.todayKm)} ק"מ, בהצעה ${num(s.depot.newKm)} ק"מ.</div>` : ""}
        <h4>בדיקת כללים</h4>
        <ul class="sv-rules">${s.rules.map(x => `<li class="${x.ok ? (x.warn ? "warn" : x.off ? "off" : "ok") : "bad"}">
          <span class="sv-ic" aria-hidden="true">${x.ok ? (x.warn ? "!" : x.off ? "–" : "✓") : "✗"}</span>
          <b>${esc(x.label)}</b>${x.ok ? "" : ` <span class="sv-chip bad">חוסם</span>`} <span class="muted">${esc(x.detail)}</span></li>`).join("")}</ul>
        ${st && st.missing.length ? `<div class="hint">חיבורים שלא חזרו: ${st.missing.map(esc).join(" · ")}</div>` : ""}
        <div class="hint">הנחה: הנהג נשאר עם האוטובוס. מרחק "הערכה" = קו אווירי × 1.35 עד שמרחק הכביש מחושב. נסיעה ריקה היא מוסקת ולא נצפתה.</div>
      </div>`;
    }
    function plain(s) {
      const a = s.timelines, mA = s.movedB.map(t => `קו ${t.line} של ${fmt(t.sched)}`).join(", "), mB = s.movedA.map(t => `קו ${t.line} של ${fmt(t.sched)}`).join(", ");
      const back = s.type === "segment" ? ` אחרי זה כל אוטובוס חוזר לסידור שלו.` : ` כל אוטובוס ממשיך בסידור של השני עד סוף היום וחוזר לחניון שלו.`;
      return `${esc(s.A)} מבצע את ${esc(mA)}. ${esc(s.B)} מבצע את ${esc(mB)}.${back}` + (a ? "" : "");
    }
    function timelineHtml(s) {
      const all = [].concat(s.timelines.A.today, s.timelines.B.today);
      const t0 = Math.floor(Math.min(...all.map(t => t.start)) / 60) * 60, t1 = Math.ceil(Math.max(...all.map(t => t.end)) / 60) * 60, w = Math.max(60, t1 - t0);
      const pos = m => ((m - t0) / w * 100).toFixed(2) + "%";
      const movedKeys = new Set([...s.movedA, ...s.movedB].map(t => t.start + "|" + t.line));
      const own = { A: new Set(s.timelines.A.today.map(t => t.start + "|" + t.line)), B: new Set(s.timelines.B.today.map(t => t.start + "|" + t.line)) };
      const ticks = []; for (let m = t0; m <= t1; m += 60) ticks.push(`<div class="tick" style="left:${pos(m)}"><span>${fmt(m)}</span></div>`);
      const row = (label, trips, who, prop) => `<div class="sv-tl-row"><div class="sv-tl-lab">${label}</div><div class="track">${ticks.join("").replace(/<span>[^<]*<\/span>/g, "")}
        ${trips.map(t => { const k = t.start + "|" + t.line, other = !own[who].has(k);
          return `<div class="bar svc sv-bar ${other ? "other" : ""} ${movedKeys.has(k) ? "moved" : ""}" style="left:${pos(t.start)};width:calc(${pos(t.end)} - ${pos(t.start)})"
            title="${esc(`${fmt(t.start)}–${fmt(t.end)} קו ${t.line}: ${t.frm} ← ${t.to}${t.edited ? " · נערך ידנית" : ""}${t.gpsIncomplete ? " · GPS חלקי" : ""}`)}">${esc(t.line)}${t.edited ? "✎" : ""}</div>`; }).join("")}
        ${s.junctions.filter(j => prop && j.veh === (who === "A" ? s.A : s.B)).map(j => `<div class="sv-jn" style="left:${pos(j.arrive)};width:calc(${pos(j.depart)} - ${pos(j.arrive)})" title="${esc(`החלפה ${j.arriveText}–${j.departText}, מרווח ${j.margin} דק'`)}"></div>`).join("")}
        </div></div>`;
      return `<div class="sv-tl" aria-label="ציר זמן לפני ואחרי">
        <div class="sv-tl-row axis"><div class="sv-tl-lab"></div><div class="track">${ticks.join("")}</div></div>
        ${row(`${esc(s.A)} היום`, s.timelines.A.today, "A")}
        ${row(`${esc(s.A)} בהצעה`, s.timelines.A.proposed, "A", true)}
        ${row(`${esc(s.B)} היום`, s.timelines.B.today, "B")}
        ${row(`${esc(s.B)} בהצעה`, s.timelines.B.proposed, "B", true)}
        <div class="legend sv-legend"><span><i class="sv-sw own"></i>נסיעה של הסידור</span><span><i class="sv-sw other"></i>נסיעה שעברה מהאוטובוס השני</span><span><i class="sv-sw jn"></i>נקודת החלפה</span></div>
      </div>`;
    }
    // ------------------------------------------------------------ rule editor
    function fieldHtml(m, val, opts) {
      const { line, ro, inherited } = opts, dis = ro || inherited ? "disabled" : "";
      const data = `data-key="${m.key}" ${line ? `data-line="${esc(line)}"` : ""}`, id = "sv_" + (line ? "l" + line.replace(/\W/g, "_") + "_" : "") + m.key;
      if (m.type === "bool") return `<input type="checkbox" id="${id}" ${data} ${val ? "checked" : ""} ${dis}>`;
      if (m.type === "enum") return `<select id="${id}" ${data} ${dis}>${m.options.map(([v, l]) => `<option value="${v}" ${v === val ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
      if (m.type === "windows") {
        const ws = val || [];
        return `<div class="sv-wins">${ws.map((w, i) => `<span class="sv-win"><span class="muted">מ־</span><input type="time" ${data} data-win="${i}" data-end="from" value="${esc(w.from)}" ${dis} aria-label="משעה"><span class="muted">עד</span><input type="time" ${data} data-win="${i}" data-end="to" value="${esc(w.to)}" ${dis} aria-label="עד שעה">${dis ? "" : `<button class="btn small" data-act="del-win" data-i="${i}" ${line ? `data-line="${esc(line)}"` : ""} aria-label="מחיקת חלון">✕</button>`}</span>`).join("") || `<span class="muted">אין</span>`}
          ${dis ? "" : `<button class="btn small" data-act="add-win" ${line ? `data-line="${esc(line)}"` : ""}>הוספת חלון</button>`}</div>`;
      }
      return `<span class="sv-numw"><input type="number" id="${id}" class="sv-num" ${data} value="${val == null ? "" : val}" ${m.min != null ? `min="${m.min}"` : ""} ${m.max != null ? `max="${m.max}"` : ""} step="${m.step || 1}" ${dis}>${m.unit ? `<span class="muted">${esc(m.unit)}</span>` : ""}</span>`;
    }
    function rulesHtml(ro) {
      const R = E.normalizeRuleset(S.draft), groups = [...new Set(E.RULES_META.map(m => m.group))];
      const opRows = groups.map(g => `<div class="sv-group">${esc(g)}</div>` + E.RULES_META.filter(m => m.group === g && m.key !== "enabled").map(m => {
        const v = R.operator[m.key], changed = JSON.stringify(v) !== JSON.stringify(E.DEFAULT_RULES[m.key]);
        return `<div class="sv-rule"><div class="sv-lab"><label for="sv_${m.key}">${esc(m.label)}</label>${m.help ? `<div class="hint">${esc(m.help)}</div>` : ""}</div>
          <div class="sv-ctl">${fieldHtml(m, v, { ro })}</div>
          <div class="sv-def">${changed ? `<button class="btn small" data-act="reset-op" data-key="${m.key}" ${ro ? "disabled" : ""} title="ברירת מחדל: ${esc(defText(m))}">איפוס</button>` : `<span class="muted">ברירת מחדל</span>`}</div></div>`;
      }).join("")).join("");
      const lineKeys = Object.keys(R.lines).concat(Object.keys(S.draft.lines).filter(l => !R.lines[l])).filter((x, i, a) => a.indexOf(x) === i)
        .sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0) || a.localeCompare(b));
      const lineCards = lineKeys.map(l => {
        const o = S.draft.lines[l] || {};
        return `<div class="sv-line"><div class="sv-line-h"><b>קו ${esc(l)}</b> <span class="muted">${Object.keys(o).length ? Object.keys(o).length + " כללים עוקפים" : "יורש הכול"}</span>
          ${ro ? "" : `<button class="btn small danger" data-act="del-line" data-line="${esc(l)}">הסרת העקיפות של הקו</button>`}</div>
          <div class="hint">מסמנים "עקיפה" כדי לקבוע ערך לקו הזה. בלי סימון הקו יורש את ערך המפעיל (מוצג באפור).</div>
          ${E.RULES_META.filter(m => !m.operatorOnly && m.key !== "blocked_mode").map(m => {
            const ov = m.key in o;
            return `<div class="sv-rule sv-lrule"><div class="sv-lab">${esc(m.label)}</div>
              <label class="sv-ov"><input type="checkbox" data-ov="${m.key}" data-line="${esc(l)}" ${ov ? "checked" : ""} ${ro ? "disabled" : ""}> עקיפה<span class="sv-sr"> של ${esc(m.label)} בקו ${esc(l)}</span></label>
              <div class="sv-ctl ${ov ? "" : "sv-inh"}">${fieldHtml(m, ov ? o[m.key] : R.operator[m.key], { line: l, ro, inherited: !ov })}</div></div>`;
          }).join("")}</div>`;
      }).join("");
      const avail = S.lines.filter(l => !S.draft.lines[l]);
      return `<section class="panel sv-rulesbox" aria-label="כללים">
        <div class="sv-rules-h"><h3>כללי ההצעות</h3>
          <span class="edit-state sv-draft" ${dirty() ? "" : "hidden"}>טיוטה: יש שינויים שלא נשמרו. ההרצה משתמשת בטיוטה.</span>
          ${ro ? `<span class="muted">צפייה בלבד: שינוי כללים זמין לעורכים ומנהלים.</span>` : `
          <button class="btn" data-act="revert" ${dirty() ? "" : "disabled"}>ביטול שינויים בכללים</button>
          ${appMode ? `<span class="muted">השמירה בכפתור "שמירה" בראש הדף.</span>` : `<button class="btn primary" data-act="save" ${dirty() ? "" : "disabled"}>שמירה</button>`}`}
        </div>
        <div class="hint">כללי המפעיל חלים על כל הקווים. כלל של קו מחליף את ערך המפעיל לאותו קו; כשבדיקה נוגעת בכמה קווים, הערך המחמיר מביניהם קובע.</div>
        <div class="sv-rules-grid">
          <div><h4 class="sv-h4">ברירות מחדל של המפעיל ${ro ? "" : `<button class="btn small" data-act="reset-all">איפוס הכול</button>`}</h4>
            <div class="sv-rlist">${opRows}</div></div>
          <div><h4>עקיפות לפי קו</h4>
            ${ro ? "" : `<div class="sv-addline"><input id="svAddLine" class="sv-in" list="svLines" placeholder="מספר קו" aria-label="מספר קו להוספה"><datalist id="svLines">${avail.map(l => `<option value="${esc(l)}">`).join("")}</datalist>
              <button class="btn small" data-act="add-line">הוספת קו</button></div>`}
            ${lineCards || `<div class="muted">אין עקיפות. כל הקווים יורשים את כללי המפעיל.</div>`}
          </div>
        </div>
      </section>`;
    }
    function defText(m) {
      const v = E.DEFAULT_RULES[m.key];
      if (m.type === "bool") return v ? "כן" : "לא";
      if (m.type === "enum") return (m.options.find(o => o[0] === v) || [])[1] || v;
      if (m.type === "windows") return v.length ? v.map(w => w.from + "–" + w.to).join(", ") : "אין";
      return v == null ? "ללא" : String(v);
    }

    render();
    loadRules().then(render);

    return {
      run, explainPair, render,
      setDay() { S.result = null; S.detail = null; S.err = ""; render(); },
      blocksChanged() { days.clear(); S.result = null; S.detail = null; render(); }, // call after a block edit is saved
      reloadRules: () => loadRules().then(render),
      syncDraft() { S.draft = appDraft() || clone(S.saved); render(); },
      isDirty: dirty,
      destroy() { if (worker) worker.terminate(); el.innerHTML = ""; el.classList.remove("sv"); },
    };
  }
  root.SavingsPanel = { mount };
})(typeof self !== "undefined" ? self : this);
