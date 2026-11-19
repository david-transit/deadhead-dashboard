// Welcome mail text and temporary password (welcome-mail spec §2). Pure: no I/O.
export const TEMP_DAYS = 7;
export const WELCOME_SUBJECT = "ברוכים הבאים ליאללה־סע: פרטי הכניסה שלך";
const SITE = "https://yalla-sa.app/";
const ABC = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";
const DIGITS = "23456789";

// 12 characters without look-alikes; always a letter and a digit (passes manage_users okPw)
export function newTempPw(rand: (n: number) => Uint32Array = (n) => crypto.getRandomValues(new Uint32Array(n))): string {
  const r = rand(14);
  const c = [...r.slice(0, 12)].map((x) => ABC[x % ABC.length]);
  if (!c.some((x) => /[0-9]/.test(x))) c[11] = DIGITS[r[12] % DIGITS.length];
  if (!c.some((x) => /[A-Za-z]/.test(x))) c[10] = ABC.slice(DIGITS.length)[r[13] % (ABC.length - DIGITS.length)];
  return c.join("");
}

const DAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
// "יום ה׳, 26.11.2026 בשעה 14:05" in Israel time
export function formatIL(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", weekday: "short", year: "numeric",
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return `יום ${DAYS[wd]}, ${Number(p.day)}.${Number(p.month)}.${p.year} בשעה ${p.hour}:${p.minute}`;
}

export function welcomeBody(p: { name: string | null; username: string; password: string; expiresAt: Date }): string {
  const who = p.name && p.name.trim() ? p.name.trim() : p.username;
  return `שלום ${who},
ברוכים הבאים ליאללה־סע!
אלה פרטי הכניסה שלך:
כניסה לאתר: ${SITE}
שם משתמש: ${p.username}
סיסמה זמנית: ${p.password}

הסיסמה הזמנית בתוקף עד ${formatIL(p.expiresAt)}. בכניסה הראשונה המערכת תבקש לבחור סיסמה חדשה ואישית.
אם לא ציפית למייל הזה, אפשר להתעלם ממנו או לכתוב לנו: support@yalla-sa.app

כתובת המייל שלך נשמרה ביאללה־סע כדי לשלוח לך פרטי כניסה והודעות על החשבון. אפשר לבקש לעיין בה, לתקן אותה או למחוק אותה בפנייה ל־support@yalla-sa.app.`;
}
