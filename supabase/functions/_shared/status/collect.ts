// Platform status (spec §2): build the 15 items from injected sources and merge with the previous snapshot.
// Every source is tried on its own; a source that fails turns only its rows grey ("unknown"), keeps their last
// value, and after 24 hours grey the row turns yellow (§2.5).
import { type Grp, type Item, type Level, pctLevel, worst, ilDate, dm, lastDay, nightlyLevel, runSummary,
  rdapExpiry, domainLevel, manualLevel } from "./levels.ts";

export interface Figures { wa_spend: number; wa_cap: number; g_day: number; g_month: number;
  mail_day: number; mail_month: number; mail_cap: number; db_bytes: number;
  alert_channel: string; manual: { key: string; checked_on: string | null }[] }
export interface Deps { figures(): Promise<Figures>; text(url: string): Promise<string>; json(url: string): Promise<unknown> }

export const GH_REPO = "david-transit/deadhead-dashboard";
export const NIGHTLY_SLUGS = ["derech-egged"];
// deadhead.yalla-sa.app answers 525 from the server side today; the Pages path under yalla-sa.app is the same file
// the operator files moved to private Storage (22.11); the public hash list in the repo names every built day
export const DAYS_URL = (s: string) => "https://yalla-sa.app/deadhead-dashboard/data/" + s + "/hashes.json";
export const RDAP_URL = "https://rdap.org/domain/yalla-sa.app";
export const WA_NOTE = "ממתין לאימות העסק";
const GH = "https://api.github.com/repos/" + GH_REPO;
const G_MONTH = 4500, G_DAY = 300, MAIL_MONTH = 3000, DB_CAP = 524288000, GH_CACHE_CAP = 10737418240;
const MB = 1048576, GB = 1073741824;

export const CATALOG: { key: string; grp: Grp; title: string; explain: string; link?: string }[] = [
  { key: "wa_spend", grp: "cost", title: "וואטסאפ", explain: "הוצאה החודש" },
  { key: "google_routes", grp: "cost", title: "Google – בדיקת מסלולים", explain: "קריאות החודש" },
  { key: "mail_day", grp: "free", title: "מיילים היום", explain: "מכסה יומית של Resend" },
  { key: "mail_month", grp: "free", title: "מיילים החודש", explain: "מכסה חודשית של Resend" },
  { key: "db_size", grp: "free", title: "מסד הנתונים", explain: "נפח ב־Supabase" },
  { key: "gh_cache", grp: "free", title: "מטמון GitHub", explain: "נפח המטמון של הריצות" },
  { key: "nightly", grp: "runs", title: "עדכון לילי", explain: "היום האחרון שנבנה בדשבורד" },
  { key: "backup", grp: "runs", title: "גיבוי שבועי", explain: "גיבוי המסד, כל יום ראשון" },
  { key: "blockers", grp: "runs", title: "בדיקת חוסמים שבועית", explain: "בדיקת דרכים חסומות לאוטובוסים" },
  { key: "domain", grp: "runs", title: "דומיין yalla-sa.app", explain: "תאריך חידוש" },
  { key: "m_cloudflare", grp: "manual", title: "Cloudflare", explain: "מייל נכנס וכניסה לכלי התכנון", link: "https://dash.cloudflare.com" },
  { key: "m_supabase", grp: "manual", title: "תעבורת Supabase", explain: "תעבורה והפעלות של פונקציות", link: "https://supabase.com/dashboard/project/xghfcdgettrcdciwwzbl/usage" },
  { key: "m_meta", grp: "manual", title: "חשבון Meta", explain: "מצב חשבון הוואטסאפ", link: "https://business.facebook.com/wa/manage/" },
  { key: "m_google_billing", grp: "manual", title: "חיוב Google Cloud", explain: "חיוב בפועל ותקציב", link: "https://console.cloud.google.com/billing" },
  { key: "m_planner", grp: "manual", title: "שרת התכנון", explain: "לא נבדק אוטומטית", link: "https://app.yalla-sa.app" },
];

const n = (x: number) => Math.round(x).toLocaleString("en-US");
const of = (v: string, c: string) => `${v} מתוך ${c}`;
const ilTime = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
const dmy = (iso: string) => `${dm(iso)}.${iso.slice(0, 4)}`;

type Reading = { level: Level; value?: number | null; cap?: number | null; reading: string; note?: string | null; link?: string | null };

export async function collect(d: Deps, prev: Item[], now: Date): Promise<Item[]> {
  const today = ilDate(now), iso = now.toISOString();
  const got: Record<string, Reading> = {};
  const failed = new Set<string>();
  const attempt = async (keys: string[], f: () => Promise<Record<string, Reading>>) => {
    try { Object.assign(got, await f()) } catch { keys.forEach(k => failed.add(k)) }
  };
  const ghJson = (path: string) => d.json(GH + path);

  await Promise.all([
    attempt(["wa_spend", "google_routes", "mail_day", "mail_month", "db_size", ...CATALOG.filter(c => c.grp === "manual").map(c => c.key)], async () => {
      const f = await d.figures();
      const r: Record<string, Reading> = {
        wa_spend: { level: pctLevel(f.wa_spend, f.wa_cap), value: f.wa_spend, cap: f.wa_cap,
          reading: of(`${Math.round(f.wa_spend * 10) / 10} ₪`, `${n(f.wa_cap)} ₪`), note: WA_NOTE },
        google_routes: { level: worst(pctLevel(f.g_month, G_MONTH), pctLevel(f.g_day, G_DAY)), value: f.g_month, cap: G_MONTH,
          reading: `${of(n(f.g_month), n(G_MONTH))} · היום ${of(n(f.g_day), n(G_DAY))}`, note: "מחקר זמני הנסיעה נספר בנפרד, במחשב." },
        mail_day: { level: pctLevel(f.mail_day, f.mail_cap), value: f.mail_day, cap: f.mail_cap, reading: of(n(f.mail_day), n(f.mail_cap)) },
        mail_month: { level: pctLevel(f.mail_month, MAIL_MONTH), value: f.mail_month, cap: MAIL_MONTH, reading: of(n(f.mail_month), n(MAIL_MONTH)) },
        db_size: { level: pctLevel(f.db_bytes, DB_CAP), value: f.db_bytes, cap: DB_CAP, reading: of(`${n(f.db_bytes / MB)}MB`, "500MB") },
      };
      for (const c of CATALOG.filter(c => c.grp === "manual")) {
        const on = f.manual.find(m => m.key === c.key)?.checked_on ?? null;
        r[c.key] = { level: manualLevel(on, today), reading: on ? `נבדק ידנית: ${dm(on)}` : "עוד לא נבדק", link: c.link };
      }
      return r;
    }),
    attempt(["gh_cache"], async () => {
      const b = Number((await ghJson("/actions/cache/usage") as { active_caches_size_in_bytes?: number }).active_caches_size_in_bytes);
      if (!Number.isFinite(b)) throw new Error("gh_cache");
      return { gh_cache: { level: pctLevel(b, GH_CACHE_CAP), value: b, cap: GH_CACHE_CAP, reading: of(`${Math.round(b / GB * 10) / 10}GB`, "10GB") } };
    }),
    ...([["backup", "backup-weekly.yml"], ["blockers", "bus-blockers-weekly.yml"]] as const).map(([k, wf]) => attempt([k], async () => {
      const j = await ghJson(`/actions/workflows/${wf}/runs?per_page=5`) as { workflow_runs?: [] };
      if (!Array.isArray(j.workflow_runs)) throw new Error(k);
      return { [k]: runSummary(j.workflow_runs, now) };
    })),
    attempt(["nightly"], async () => {
      const days = await Promise.all(NIGHTLY_SLUGS.map(async s => lastDay(await d.text(DAYS_URL(s)))));
      if (days.some(x => !x)) throw new Error("nightly");
      const oldest = (days as string[]).sort()[0];
      return { nightly: { level: worst(...days.map(x => nightlyLevel(x, today))), reading: `היום האחרון: ${dm(oldest)}` } };
    }),
    attempt(["domain"], async () => {
      const exp = rdapExpiry(await d.json(RDAP_URL));
      if (!exp) throw new Error("rdap");
      return { domain: { level: domainLevel(exp, now), reading: `בתוקף עד ${dmy(exp)}` } };
    }),
  ]);

  const before = new Map(prev.map(i => [i.key, i]));
  return CATALOG.map((c, ord) => {
    const p = before.get(c.key);
    const base = { key: c.key, ord, grp: c.grp, title: c.title, explain: c.explain };
    if (failed.has(c.key) || !got[c.key]) {
      const since = p?.unknown_since ?? iso;
      return { ...base, value: p?.value ?? null, cap: p?.cap ?? null, reading: p?.reading ?? "—", link: p?.link ?? c.link ?? null,
        level: now.getTime() - Date.parse(since) >= 86400000 ? "warn" : "unknown", note: `לא נבדק – ${ilTime(now)}`,
        checked_at: p?.checked_at ?? iso, unknown_since: since, red_since: p?.red_since ?? null }; // red stays remembered while grey (no second alert)
    }
    const r = got[c.key];
    return { ...base, value: r.value ?? null, cap: r.cap ?? null, level: r.level, reading: r.reading, note: r.note ?? null,
      link: r.link ?? c.link ?? null, checked_at: iso, unknown_since: null,
      red_since: r.level === "bad" ? (p?.red_since ?? iso) : null };
  });
}
