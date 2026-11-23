// R51 live check (David 23.11.2026), the dashboard side: the typed km ("עדכון ק״מ ידני"), the warning rules around it,
// and the result block of "בדיקה עכשיו". The real functions are taken from assets/app.js (top-level, one per block) and
// run with small stand-ins, so the test follows the code as it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SRC = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const LINES = SRC.split("\n");
// a top-level "function name(" / "const name=" and its indented continuation lines
function grab(name) {
  const i = LINES.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`) || l.startsWith(`const ${name}=`) || l.startsWith(`let ${name}=`));
  assert.ok(i >= 0, "not found in app.js: " + name);
  const out = [LINES[i]];
  for (let j = i + 1; j < LINES.length && /^\s/.test(LINES[j]); j++) out.push(LINES[j]);
  return out.join("\n");
}
const NAMES = ["nf", "esc", "pk", "kmTxt", "rokChanged", "rokKey", "rkmM", "rkmOf", "rkmWhen", "manualDay", "legProblems", "GCHKERR", "gchkErr", "gchkHtml"];
function app(state = {}) {
  const body = `
    let DRAFT={rkm:{}},DV=0,RKM=[],RKMM=null,RKMV=-1,RKMBY={},GCHK=null;
    const subPair=(a,b)=>[a,b], hav=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1])*111, ROUTE={unresolved:()=>false}, rokOf=()=>null, gvOk=()=>false,
      rpKey=g=>g.k, errText=e=>String(e&&e.message||e);
    ${NAMES.map(grab).join("\n")}
    return {manualDay,legProblems,gchkHtml,gchkErr,rkmM,
      set(o){if("RKM" in o){RKM=o.RKM;RKMM=null}if("DRAFT" in o){DRAFT=o.DRAFT;DV++}if("GCHK" in o) GCHK=o.GCHK;if("RKMBY" in o) RKMBY=o.RKMBY}}`;
  const a = new Function(body)();
  a.set(state);
  return a;
}
const A = [31.76635, 35.14881], B = [31.79996, 35.14805];
const leg = (km, x = {}) => ({ kind: "empty", a: A, b: B, km, start: 600, end: 660, frm: "הדסה", to: "מבשרת", ...x });
const day = (...items) => ({ day: "2026-11-20", vehicles: [{ veh: "1", items, empty_day_km: 0 }] });
const row = (km, our_km, x = {}) => ({ id: "r1", a_lat: A[0], a_lon: A[1], b_lat: B[0], b_lon: B[1], km, our_km, created_by: "u1", created_at: "2026-11-23T08:00:00Z", ...x });

test("typed km is used while our km is unchanged; ours kept as km_calc; the day's empty km follows", () => {
  const a = app({ RKM: [row(6.2, 10.0)] });
  const J = a.manualDay(day(leg(10.05)));
  const i = J.vehicles[0].items[0];
  assert.equal(i.km, 6.2);
  assert.equal(i.km_calc, 10.05);
  assert.ok(i.kmman);
  assert.equal(J.vehicles[0].empty_day_km, 6.2);
});

test("our km changed since the typed km: ours stays, the old typed km is kept aside to explain", () => {
  const a = app({ RKM: [row(6.2, 10.0)] });
  const i = a.manualDay(day(leg(12.5))).vehicles[0].items[0];
  assert.equal(i.km, 12.5);
  assert.ok(!i.kmman);
  assert.equal(i.kmmanold.km, 6.2);
});

test("no typed km: the day is returned as it is", () => {
  const a = app();
  const J = day(leg(10));
  assert.equal(a.manualDay(J), J);
});

test("a draft typed km counts before saving; a draft cancel (null) removes the saved one", () => {
  const k = "31.76635,35.14881>31.79996,35.14805";
  let a = app({ DRAFT: { rkm: { [k]: { a_lat: A[0], a_lon: A[1], b_lat: B[0], b_lon: B[1], km: 7, our_km: 10 } } } });
  assert.equal(a.manualDay(day(leg(10))).vehicles[0].items[0].km, 7);
  a = app({ RKM: [row(6.2, 10.0)], DRAFT: { rkm: { [k]: null } } });
  assert.equal(a.manualDay(day(leg(10))).vehicles[0].items[0].km, 10);
});

test("warning: hidden with a typed km, back (with 'השתנה מאז שאושר') when our km changed", () => {
  const a = app({ RKM: [row(6.2, 10.0)] });
  assert.deepEqual(app().legProblems(leg(10)), ["detour"]);
  const changed = a.manualDay(day(leg(12.5))).vehicles[0].items[0];
  assert.deepEqual(a.legProblems(changed), ["detour", "okchg"]);
  const same = a.manualDay(day(leg(10))).vehicles[0].items[0];
  assert.equal(a.legProblems(same), null);
  // "לא נכנס בזמן" is never hidden by a typed km
  assert.deepEqual(a.legProblems({ ...same, tight: true }), ["time"]);
});

const G = { k: "g1", km: 10, frm: "הדסה", to: "מבשרת", A, B };
test("check result: Google's km beside ours, credited 'Google Maps' in English, then the two actions", () => {
  const a = app({ GCHK: { k: "g1", km: 6.3 } });
  const h = a.gchkHtml(G, 0);
  assert.match(h, /<span lang="en" dir="ltr">Google Maps<\/span>: <b>6\.3<\/b> ק״מ/);
  assert.match(h, /שלנו: <b>10<\/b> ק״מ/);
  assert.match(h, /data-rgchkok="0">אישור מסלול</);
  assert.match(h, /data-rgman="0"[^>]*>עדכון ק״מ ידני</);
  assert.match(h, /role="status"/);
});

test("the manual km field starts empty: no value, no placeholder, and Google's km is nowhere in it", () => {
  const a = app({ GCHK: { k: "g1", km: 6.3 } });
  const h = a.gchkHtml(G, 0);
  const man = h.slice(h.indexOf('class="rwnote rwman"'));
  const input = man.match(/<input[^>]*>/)[0];
  assert.ok(!/\bvalue=/.test(input) && !/placeholder=/.test(input) && !/list=/.test(input), input);
  assert.ok(!man.includes("6.3") && !man.includes("6,3"), "Google's km is not offered in the manual part");
});

test("the result belongs to its warning only, and nothing shows before a check", () => {
  assert.equal(app({ GCHK: { k: "other", km: 6.3 } }).gchkHtml(G, 0), "");
  assert.equal(app().gchkHtml(G, 0), "");
  assert.match(app({ GCHK: { k: "g1", busy: true } }).gchkHtml(G, 0), /בודק…/);
  assert.match(app({ GCHK: { k: "g1", km: null } }).gchkHtml(G, 0), /לא נמצא מסלול/);
});

test("errors in plain Hebrew (quota, permission, not configured)", () => {
  const a = app();
  assert.match(a.gchkErr(new Error("quota")), /המכסה/);
  assert.match(a.gchkErr(new Error("not_allowed")), /הרשאה/);
  assert.match(a.gchkErr(new Error("not_configured")), /לא הופעלה/);
  assert.match(app({ GCHK: { k: "g1", err: "x" } }).gchkHtml(G, 0), /class="msg err">x</);
});

test("Google's km stays in memory, in the warnings list only: no storage, no log, no map", () => {
  const lines = LINES.filter((l) => l.includes("GCHK"));
  for (const l of lines) assert.ok(!/localStorage|sessionStorage|lsSet\(|upsert\(|console\.|\/rest\/v1/.test(l), "GCHK line writes somewhere: " + l.trim().slice(0, 120));
  // the button and the result are drawn by drawRouteList only (the list has no map); the map dialogs never call them
  for (const fn of ["rpShow", "legMap", "openRowMap"]) {
    const i = LINES.findIndex((l) => l.startsWith(`function ${fn}(`) || l.startsWith(`async function ${fn}(`));
    if (i < 0) continue;
    let s = LINES[i]; for (let j = i + 1; j < LINES.length && /^\s/.test(LINES[j]); j++) s += LINES[j];
    assert.ok(!/gchkHtml|data-rgchk/.test(s), fn + " must not show the Google check");
  }
  assert.match(grab("drawRouteList"), /data-rgchk=/);
  assert.match(grab("drawRouteList"), /gchkHtml\(g,n\)/);
  // closing the list drops the result
  assert.match(grab("rwDlg"), /addEventListener\("close",\(\)=>\{GCHK=null\}\)/);
});

test("the check is offered only to users with the capability, next to a 'לבדיקה ידנית' warning", () => {
  assert.match(grab("drawRouteList"), /canEdit\(\)&&manual\(g\.legs\[0\]\.i,g\.kinds\)\?`<button[^`]*data-rgchk/);
});
