// Platform status (spec: yalla-sa-support/docs/superpowers/specs/2026-11-19-platform-status-design.md §2):
// pure level calculations and source parsers. No I/O here — tested in Node.
export type Level = "ok" | "warn" | "bad" | "unknown" | "manual";
export type Grp = "cost" | "free" | "runs" | "manual";
export interface Item {
  key: string; ord: number; grp: Grp; title: string; explain: string;
  value: number | null; cap: number | null; level: Level;
  reading: string; note: string | null; link: string | null;
  checked_at: string; unknown_since: string | null; red_since: string | null;
}
export interface GhRun { status: string; conclusion: string | null; created_at: string; html_url: string }

const DAY = 86400000;

export function pctLevel(value: number, cap: number | null): Level {
  if (!cap || cap <= 0 || !Number.isFinite(value)) return "unknown";
  const r = value / cap;
  return r < 0.8 ? "ok" : r < 0.95 ? "warn" : "bad";
}

const RANK: Record<Level, number> = { ok: 0, manual: 0, unknown: 1, warn: 2, bad: 3 };
export function worst(...ls: Level[]): Level {
  return ls.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "ok" as Level);
}

const IL_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" });
const IL_HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", hourCycle: "h23" });
export const ilDate = (now: Date): string => IL_DATE.format(now);
export const ilHour = (now: Date): number => Number(IL_HOUR.format(now));

// whole days between two YYYY-MM-DD dates (b - a)
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
// "2026-11-17..." -> "17.11"
export const dm = (iso: string) => { const [, m, d] = iso.slice(0, 10).split("-"); return `${Number(d)}.${Number(m)}` };

// the last built day, from data/<slug>/hashes.json ({"YYYY-MM-DD": sha256}) or the older days.js
export function lastDay(daysJs: string): string | null {
  try {
    const h = JSON.parse(daysJs || "");
    if (h && typeof h === "object" && !Array.isArray(h)) {
      const ds = Object.keys(h).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
      return ds.length ? ds[ds.length - 1] : null;
    }
  } catch { /* not JSON: days.js */ }
  const m = /"days"\s*:\s*\[([^\]]*)\]/.exec(daysJs || "");
  if (!m) return null;
  const days = [...m[1].matchAll(/"(\d{4}-\d{2}-\d{2})"/g)].map(x => x[1]).sort();
  return days.length ? days[days.length - 1] : null;
}

export function nightlyLevel(last: string | null, today: string): Level {
  if (!last) return "unknown";
  const d = daysBetween(last, today);
  return d <= 2 ? "ok" : d === 3 ? "warn" : "bad";
}

// latest finished run of a weekly workflow; a running one is skipped, cancelled counts as failed,
// nothing finished in the last 8 days = did not run
export function runSummary(runs: GhRun[], now: Date): { level: Level; reading: string; link: string | null } {
  const done = (runs || []).filter(r => r.status === "completed").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const r = done[0];
  if (!r || now.getTime() - Date.parse(r.created_at) > 8 * DAY) return { level: "bad", reading: "לא רץ", link: null };
  if (r.conclusion === "success") return { level: "ok", reading: `הצליח · ${dm(r.created_at)}`, link: null };
  return { level: "bad", reading: `הריצה האחרונה נכשלה · ${dm(r.created_at)}`, link: r.html_url };
}

export function rdapExpiry(json: unknown): string | null {
  const ev = (json as { events?: { eventAction?: string; eventDate?: string }[] })?.events;
  const e = Array.isArray(ev) ? ev.find(x => x && x.eventAction === "expiration" && x.eventDate) : null;
  return e ? e.eventDate!.slice(0, 10) : null;
}

export function domainLevel(expiry: string | null, now: Date): Level {
  if (!expiry) return "unknown";
  const d = daysBetween(ilDate(now), expiry);
  return d <= 7 ? "bad" : d <= 30 ? "warn" : "ok";
}

// manual rows: grey, yellow when not checked for more than 30 days (or never)
export function manualLevel(checkedOn: string | null, today: string): Level {
  if (!checkedOn) return "warn";
  return daysBetween(checkedOn, today) > 30 ? "warn" : "manual";
}
