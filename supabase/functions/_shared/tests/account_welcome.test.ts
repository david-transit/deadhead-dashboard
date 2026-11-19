import { test } from "node:test";
import assert from "node:assert/strict";
import { newTempPw, formatIL, welcomeBody, WELCOME_SUBJECT, TEMP_DAYS } from "../account/welcome.ts";

test("constants", () => {
  assert.equal(TEMP_DAYS, 7);
  assert.equal(WELCOME_SUBJECT, "ברוכים הבאים ליאללה־סע: פרטי הכניסה שלך");
});
test("newTempPw: 12 chars, allowed alphabet, letter and digit", () => {
  for (let i = 0; i < 200; i++) {
    const p = newTempPw();
    assert.match(p, /^[23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ]{12}$/); assert.match(p, /[A-Za-z]/); assert.match(p, /[0-9]/);
  }
});
test("newTempPw: all-letter draw still gets a digit", () => {
  assert.match(newTempPw((n) => new Uint32Array(n).fill(10)), /[0-9]/);
});
test("newTempPw: all-digit draw still gets a letter", () => {
  assert.match(newTempPw((n) => new Uint32Array(n).fill(0)), /[A-Za-z]/);
});
test("formatIL: Israel time", () => assert.equal(formatIL(new Date("2026-11-26T12:05:00Z")), "יום ה׳, 26.11.2026 בשעה 14:05"));
test("welcomeBody: all fields, exact lines", () => {
  const b = welcomeBody({ name: "אבי", username: "avi", password: "Ab3defGh5jkm", expiresAt: new Date("2026-11-26T12:05:00Z") });
  for (const s of ["שלום אבי,", "ברוכים הבאים ליאללה־סע!", "אלה פרטי הכניסה שלך:", "כניסה לאתר: https://yalla-sa.app/", "שם משתמש: avi",
    "סיסמה זמנית: Ab3defGh5jkm", "הסיסמה הזמנית בתוקף עד יום ה׳, 26.11.2026 בשעה 14:05. בכניסה הראשונה המערכת תבקש לבחור סיסמה חדשה ואישית.",
    "אם לא ציפית למייל הזה, אפשר להתעלם ממנו או לכתוב לנו: support@yalla-sa.app",
    "כתובת המייל שלך נשמרה ביאללה־סע כדי לשלוח לך פרטי כניסה והודעות על החשבון. אפשר לבקש לעיין בה, לתקן אותה או למחוק אותה בפנייה ל־support@yalla-sa.app."])
    assert.ok(b.includes(s), s);
});
test("welcomeBody: no display name -> username", () => {
  assert.ok(welcomeBody({ name: null, username: "avi", password: "x", expiresAt: new Date() }).startsWith("שלום avi,"));
  assert.ok(welcomeBody({ name: "  ", username: "avi", password: "x", expiresAt: new Date() }).startsWith("שלום avi,"));
});
