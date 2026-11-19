import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, oneLine } from "../status/notify.ts";
import type { Item, Level } from "../status/levels.ts";

const it = (key: string, title: string, level: Level, reading = "x"): Item => ({ key, ord: 0, grp: "runs", title, explain: "", value: null, cap: null,
  level, reading, note: null, link: null, checked_at: "2026-11-19T10:00:00Z", unknown_since: null, red_since: null });
const AM10 = new Date("2026-11-19T08:00:00Z"); // 10:00 Israel
const AM0759 = new Date("2026-11-19T05:59:00Z");
const AM0810 = new Date("2026-11-19T06:10:00Z");
const blk = (l: Level) => it("blockers", "בדיקת חוסמים שבועית", l, "הריצה האחרונה נכשלה · 17.11");

test("a new red sends immediately, with the item", () => {
  const r = decide([blk("ok")], [blk("bad")], AM10, "2026-11-19");
  assert.ok(r.immediate && r.immediate.includes("אדום: בדיקת חוסמים שבועית – הריצה האחרונה נכשלה · 17.11"));
  assert.ok(r.immediate!.startsWith("יאללה־סע – מצב הפלטפורמה"));
  assert.ok(r.immediate!.includes("ללוח: https://yalla-sa.app/?panel=status"));
});
test("red that stays red does not send again", () => {
  assert.equal(decide([blk("bad")], [blk("bad")], AM10, "2026-11-19").immediate, null);
});
test("red -> ok -> red sends again", () => {
  assert.ok(decide([blk("bad")], [blk("ok")], AM10, null).immediate === null);
  assert.ok(decide([blk("ok")], [blk("bad")], AM10, null).immediate);
});
test("first run (no previous row) that is red sends", () => {
  assert.ok(decide([], [blk("bad")], AM10, null).immediate);
});
test("digest only at 08 Israel, once a day, only with yellow/red", () => {
  const y = [it("mail_day", "מיילים היום", "warn", "82 מתוך 100")];
  assert.equal(decide(y, y, AM0759, "2026-11-18").markDigest, false);
  const r = decide(y, y, AM0810, "2026-11-18");
  assert.equal(r.markDigest, true);
  assert.ok(r.digest && r.digest.includes("צהוב: מיילים היום – 82 מתוך 100"));
  const g = [it("a", "א", "ok"), it("m", "ב", "manual")];
  const r2 = decide(g, g, AM0810, "2026-11-18");
  assert.equal(r2.digest, null); assert.equal(r2.markDigest, true);
  assert.equal(decide(y, y, AM0810, "2026-11-19").markDigest, false);
});
test("a red that appears at the digest run goes in the digest only (one message)", () => {
  const r = decide([blk("ok")], [blk("bad")], AM0810, null);
  assert.equal(r.immediate, null); assert.ok(r.digest && r.digest.includes("אדום: בדיקת חוסמים"));
});
test("digest lists red before yellow", () => {
  const n = [it("mail_day", "מיילים היום", "warn"), blk("bad")];
  const d = decide(n, n, AM0810, null).digest!;
  assert.ok(d.indexOf("אדום:") < d.indexOf("צהוב:"));
});
test("no emails or phone numbers in the text", () => {
  const n = [blk("bad"), it("mail_day", "מיילים היום", "warn", "82 מתוך 100")];
  for (const t of [decide([], n, AM10, null).immediate!, decide([], n, AM0810, null).digest!]) { assert.ok(!t.includes("@")); assert.ok(!/\d{9,}/.test(t)) }
});
test("red -> grey (source down) -> red again does not send twice", () => {
  const grey = { ...blk("unknown"), red_since: "2026-11-19T07:00:00Z" };
  assert.equal(decide([grey], [blk("bad")], AM10, "2026-11-19").immediate, null);
});

test("a grey-turned-yellow line says it was not checked", () => {
  const stale = { ...blk("warn"), unknown_since: "2026-11-18T05:00:00Z", note: "לא נבדק – 08:07" };
  assert.ok(decide([stale], [stale], AM0810, null).digest!.includes("צהוב: בדיקת חוסמים שבועית – הריצה האחרונה נכשלה · 17.11 (לא נבדק – 08:07)"));
});
test("oneLine joins the lines for WhatsApp templates (no newlines)", () => {
  const t = decide([blk("ok")], [blk("bad")], AM10, null).immediate!;
  assert.equal(oneLine(t).includes(String.fromCharCode(10)), false);
  assert.ok(oneLine(t).startsWith("יאללה־סע – מצב הפלטפורמה · אדום:"));
});
