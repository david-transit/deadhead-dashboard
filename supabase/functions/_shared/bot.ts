// Menu bot (yalla-sa support, spec §4). Pure: decides replies and the next state; the caller sends and stores.

export interface BotState { step: "menu" | "idle"; misses: number }
export interface Hours { days: number[]; from: string; to: string } // days 0=Sun..6=Sat, "HH:MM" Israel time
export interface BotOut { replies: string[]; state: BotState; handoff: boolean; optOut: boolean }

// Approved by David 18.11.2026 (spec §4), verbatim.
export const MENU = [
  "שלום, הגעת לשירות הלקוחות של יאללה־סע 🚌",
  "במה נוכל לעזור?",
  "1️⃣ בעיה בכניסה למערכת",
  "2️⃣ שאלה על כלי הנסיעות הריקות",
  "3️⃣ לדבר עם נציג",
  "(אפשר לכתוב \"הסר\" כדי להפסיק לקבל הודעות מערכת)",
].join("\n");
const HELPED = "זה עזר? אם לא, כתוב 3";
const HANDOFF = "העברנו לנציג. נחזור אליך בהקדם";
const OPTED_OUT = "הוסרת. לא נשלח לך עוד הודעות מערכת";
const OPT_OUT_WORDS = new Set(["הסר", "להסיר", "הסירו", "הסרה", "stop", "unsubscribe"]);

// keep letters and digits only (drops punctuation, emoji, spaces at the edges), lower-case Latin
const norm = (t: string) => String(t ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim().replace(/\s+/g, " ");

export function isOptOut(text: string): boolean {
  return OPT_OUT_WORDS.has(norm(text));
}

const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function inHours(now: Date, h: Hours): boolean {
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const hm = `${p.hour}:${p.minute}`;
  return h.days.includes(DAYS.indexOf(p.weekday)) && hm >= h.from && hm < h.to;
}

export function botStep(o: {
  text: string; state: BotState | null; now: Date; hours: Hours;
  answers: Record<string, string>; aiLeft: number; menuLeft: number;
}): BotOut {
  const st: BotState = o.state ?? { step: "idle", misses: 0 };
  if (isOptOut(o.text)) return { replies: [OPTED_OUT], state: { step: "idle", misses: 0 }, handoff: false, optOut: true };
  if (o.menuLeft <= 0) return { replies: [], state: st, handoff: true, optOut: false };
  if (!inHours(o.now, o.hours)) {
    return { replies: [o.answers.hours_off], state: { step: "idle", misses: 0 }, handoff: true, optOut: false };
  }
  if (st.step !== "menu") return { replies: [MENU], state: { step: "menu", misses: 0 }, handoff: false, optOut: false };
  const choice = norm(o.text);
  if (choice === "3") return { replies: [HANDOFF], state: { step: "idle", misses: 0 }, handoff: true, optOut: false };
  if ((choice === "1" || choice === "2") && o.answers[choice]) {
    return { replies: [o.answers[choice], HELPED], state: { step: "menu", misses: 0 }, handoff: false, optOut: false };
  }
  if (st.misses + 1 >= 2) return { replies: [HANDOFF], state: { step: "idle", misses: 0 }, handoff: true, optOut: false };
  return { replies: [MENU], state: { step: "menu", misses: st.misses + 1 }, handoff: false, optOut: false };
}
