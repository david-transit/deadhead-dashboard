/* R53 tabs "סידורים", "פערי ק״מ מול המפעיל", "לקחים" (render from the loaded payloads; called by pva.js). */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const ST = { planned: "כמתוכנן", changed: "השתנתה", added: "נוספה", not_done: "לא בוצעה" };
  const VERD = { match: "תואם", third: "לבדיקה פרטנית", op: "לבדיקה פרטנית", ours: "לבדיקה פרטנית", pending: "לבדיקה פרטנית", "n/a": "–" };
  const LES = { via_stop: "המפעיל עובר דרך מוסך או חניון ביניים, ואנחנו נוסעים ישר", other_destination: "יעד אחר לנסיעה הריקה",
    missing_in_ours: "נסיעות ריקות של המפעיל שלא ראינו בכלל", km_gap: "פערי ק״מ מול המפעיל" };

  function sid(days, h) {
    const box = $("#pSid"), rows = days.flatMap(d => d.sidurim.map(s => ({ d: d.day, s })));
    const cnt = (s, k) => s.trips.filter(t => t.status === k).length;
    box.innerHTML = `<div class="col"><table class="tbl"><thead><tr><th>יום</th><th>סידור</th><th>רכבים</th><th>כמתוכנן</th><th>השתנו</th><th>נוספו</th><th>לא בוצעו</th></tr></thead><tbody>` +
      rows.map((r, i) => { const T = r.s.trips, veh = [...new Set(T.map(t => t.veh).filter(Boolean))];
        return `<tr><td>${h.dlabel(r.d)}</td><td><button class="btn" data-i="${i}" aria-expanded="false">${h.esc(r.s.sidur)}${r.s.in_plan ? "" : " (לא במפה)"}</button></td><td>${h.esc(veh.join(", "))}</td>
          <td>${cnt(r.s, "planned")}</td><td>${cnt(r.s, "changed")}</td><td>${cnt(r.s, "added")}</td><td>${cnt(r.s, "not_done")}</td></tr><tr hidden id="sd${i}"><td colspan="7"></td></tr>`; }).join("") + `</tbody></table></div>`;
    box.querySelectorAll("button[data-i]").forEach(b => b.onclick = () => {
      const i = +b.dataset.i, tr = $("#sd" + i), open = tr.hidden; tr.hidden = !open; b.setAttribute("aria-expanded", open);
      if (open) tr.firstElementChild.innerHTML = rows[i].s.trips.map(t => `<div class="trip${t.status === "not_done" ? " nd" : ""}" style="cursor:default"><span>${h.hm(t.t0)}</span>
        <span>${t.kind === "service" ? "קו " + h.esc(t.line || "") + " · " : ""}${h.esc(h.place(t.a))} ← ${h.esc(h.place(t.b))}</span><span class="km">${h.nf(h.kmOf(t))} ק״מ</span>
        ${t.kind === "service" ? `<span class="tag plan">${ST[t.status]}</span>` : h.TAG(t)}</div>`).join("");
    });
  }

  function gap(days, h) {
    const T = days.flatMap(d => d.sidurim.flatMap(s => s.trips)).filter(t => t.kind === "empty" && t.status !== "not_done" && t.a && t.b);
    const g = new Map();
    for (const t of T) { if (!["op", "ours", "third", "pending"].includes(t.verdict)) continue;
      const k = t.desc + "|" + h.place(t.a) + "|" + h.place(t.b); const x = g.get(k) || { t, n: 0 }; x.n++; g.set(k, x); }
    const G = [...g.values()].sort((a, b) => b.n - a.n), U = days.flatMap(d => d.unresolved.map(t => ({ ...t, day: d.day })));
    $("#pGap").innerHTML = `<div class="col"><h2>פערי ק״מ (${G.length} צמדים)</h2><table class="tbl"><thead><tr><th>תיאור המפעיל</th><th>מ־</th><th>אל</th><th>המפעיל</th><th>שלנו</th><th>הכרעה</th><th>נסיעות</th></tr></thead><tbody>` +
      G.map(x => `<tr><td>${h.esc(x.t.desc)}</td><td>${h.esc(h.place(x.t.a))}</td><td>${h.esc(h.place(x.t.b))}</td><td>${h.nf(x.t.op_km)}</td><td>${h.nf(x.t.our_km)}</td><td>${VERD[x.t.verdict]}</td><td>${x.n}</td></tr>`).join("") +
      `</tbody></table><h2>לבדיקה: נסיעות ריקות בלי מוצא או יעד ידוע (${U.length})</h2><table class="tbl"><thead><tr><th>יום</th><th>שעה</th><th>סידור</th><th>רכב</th><th>תיאור המפעיל</th></tr></thead><tbody>` +
      U.map(t => `<tr><td>${h.dlabel(t.day)}</td><td>${h.hm(t.t0)}</td><td>${h.esc(t.sidur)}</td><td>${h.esc(t.veh)}</td><td>${h.esc(t.desc)}</td></tr>`).join("") + `</tbody></table>` + places(days, h) + `</div>`;
  }

  // end points that are not the operator's depots (David 19.11: needed later for forced empty legs)
  function places(days, h) {
    const m = new Map(); for (const d of days) for (const p of d.places || []) if (!m.has(p.name)) m.set(p.name, p);
    const P = [...m.values()].sort((a, b) => a.name.localeCompare(b.name, "he"));
    return `<h2>נקודות קצה שאינן חניונים (${P.length})</h2><p class="sub">השם במפת הבסיס, והתחנה שממנה יוצאות הנסיעות שלו. "נלמד" = זוהה מנסיעות השירות של היום; "קבוע" = אושר ונשמר.</p>
      <table class="tbl"><thead><tr><th>שם אצל המפעיל</th><th>תחנה</th><th>קוד</th><th>מקור</th></tr></thead><tbody>` +
      P.map(p => `<tr><td>${h.esc(p.name)}</td><td>${h.esc(p.stop)}</td><td>${h.esc(p.code)}</td><td>${p.src === "fixed" ? "קבוע" : "נלמד"}</td></tr>`).join("") + `</tbody></table>`;
  }

  function les(days, h) {
    const agg = new Map();
    for (const d of days) for (const l of d.lessons || []) { const x = agg.get(l.type) || { ...l, count: 0, examples: [] }; x.count += l.count; if (x.examples.length < 5) x.examples.push(...l.examples.slice(0, 5 - x.examples.length)); agg.set(l.type, x); }
    const ex = (l, e) => l.type === "km_gap" ? `${h.esc(e.desc)} · ${VERD[e.verdict]} · ${e.n} נסיעות` : l.type === "missing_in_ours" ? `סידור ${h.esc(e.sidur)} · רכב ${h.esc(e.veh)} · ${h.hm(e.t0)} · ${h.esc(e.op)}`
      : `רכב ${h.esc(e.veh)} · ${h.hm(e.t0)} · המפעיל: ${h.esc(e.op)}${e.via ? " (דרך " + h.esc(e.via) + ")" : ""} · אנחנו: ${h.esc(e.ours)}`;
    $("#pLes").innerHTML = agg.size ? [...agg.values()].map(l => `<div class="col" style="margin-bottom:12px"><h2>${LES[l.type] || l.type}: ${l.count}</h2>
      <p class="sub">${h.esc(l.why)}</p><ul>${l.examples.map(e => `<li>${ex(l, e)}</li>`).join("")}</ul></div>`).join("") : `<div class="empty">אין לקחים לתקופה (חסרים קובצי היום שלנו)</div>`;
  }

  window.PVA_TABS = { tSid: sid, tGap: gap, tLes: les };
})();
