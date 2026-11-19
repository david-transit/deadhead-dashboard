import { test } from "node:test";
import assert from "node:assert/strict";
import { MENU, isOptOut, inHours, botStep, type Hours } from "../bot.ts";

const HOURS: Hours = { days: [0, 1, 2, 3, 4], from: "08:00", to: "17:00" };
const ANSWERS = { "1": "תשובה על כניסה", "2": "תשובה על הכלי", hours_off: "קיבלנו. נחזור אליך ביום העבודה הבא" };
// Israel is UTC+2 in November (winter time)
const thuNoon = new Date("2026-11-19T10:00:00Z");
const base = { state: null, now: thuNoon, hours: HOURS, answers: ANSWERS, aiLeft: 20, menuLeft: 50 };

test("isOptOut: accepts the opt-out word in its common forms", () => {
  for (const t of ["הסר", " הסר ", "הסר!", "להסיר", "STOP", "stop", "הסר 🙏"]) assert.equal(isOptOut(t), true, t);
});
test("isOptOut: ordinary sentences containing the letters are not opt-out", () => {
  for (const t of ["הסרטון לא עובד", "איך מסירים קו?", "1"]) assert.equal(isOptOut(t), false, t);
});

test("inHours: Thursday 16:59 Israel time is open, Friday/Saturday closed, Sunday 07:59 closed", () => {
  assert.equal(inHours(new Date("2026-11-19T14:59:00Z"), HOURS), true);  // Thu 16:59
  assert.equal(inHours(new Date("2026-11-19T15:00:00Z"), HOURS), false); // Thu 17:00
  assert.equal(inHours(new Date("2026-11-20T07:00:00Z"), HOURS), false); // Fri 09:00
  assert.equal(inHours(new Date("2026-11-21T10:00:00Z"), HOURS), false); // Sat
  assert.equal(inHours(new Date("2026-11-22T05:59:00Z"), HOURS), false); // Sun 07:59
});
test("inHours: follows Israel daylight time (summer UTC+3, winter UTC+2)", () => {
  assert.equal(inHours(new Date("2026-10-22T05:30:00Z"), HOURS), true);  // Thu 08:30 summer time
  assert.equal(inHours(new Date("2026-10-29T05:30:00Z"), HOURS), false); // Thu 07:30 winter time
});

test("botStep: first message in hours sends the menu", () => {
  const o = botStep({ ...base, text: "שלום" });
  assert.deepEqual(o.replies, [MENU]);
  assert.equal(o.state.step, "menu");
  assert.equal(o.handoff, false);
  assert.ok(MENU.includes("1️⃣ בעיה בכניסה למערכת") && MENU.includes("3️⃣ לדבר עם נציג") && MENU.includes("הסר"));
});

test("botStep: choosing 1 sends the ready answer and asks if it helped", () => {
  const o = botStep({ ...base, state: { step: "menu", misses: 0 }, text: "1" });
  assert.deepEqual(o.replies, ["תשובה על כניסה", "זה עזר? אם לא, כתוב 3"]);
  assert.equal(o.handoff, false);
});

test("botStep: choosing 3 hands off to an agent", () => {
  const o = botStep({ ...base, state: { step: "menu", misses: 0 }, text: "3" });
  assert.equal(o.handoff, true);
  assert.deepEqual(o.replies, ["העברנו לנציג. נחזור אליך בהקדם"]);
});

test("botStep: two unclear messages in a row hand off", () => {
  const a = botStep({ ...base, state: { step: "menu", misses: 0 }, text: "מה?" });
  assert.equal(a.state.misses, 1);
  assert.equal(a.handoff, false);
  const b = botStep({ ...base, state: a.state, text: "לא הבנתי" });
  assert.equal(b.handoff, true);
});

test("botStep: opt-out word confirms and flags optOut", () => {
  const o = botStep({ ...base, state: { step: "menu", misses: 0 }, text: "הסר" });
  assert.equal(o.optOut, true);
  assert.deepEqual(o.replies, ["הוסרת. לא נשלח לך עוד הודעות מערכת"]);
});

test("botStep: outside hours answers hours_off and hands off", () => {
  const o = botStep({ ...base, now: new Date("2026-11-21T10:00:00Z"), text: "שלום" });
  assert.deepEqual(o.replies, [ANSWERS.hours_off]);
  assert.equal(o.handoff, true);
});

test("botStep: no menu replies left today -> silent handoff", () => {
  const o = botStep({ ...base, menuLeft: 0, text: "שלום" });
  assert.deepEqual(o.replies, []);
  assert.equal(o.handoff, true);
});

test("botStep: opt-out still works when the daily menu limit is used up", () => {
  const o = botStep({ ...base, menuLeft: 0, text: "הסר" });
  assert.equal(o.optOut, true);
});
