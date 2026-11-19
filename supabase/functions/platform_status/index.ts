// platform_status (yalla-sa control panel tab "מצב הפלטפורמה"): the hourly check, called by pg_cron through pg_net
// (migrations 20261121100000/101000) and by platform_status_refresh() ("בדיקה עכשיו").
// Spec: yalla-sa-support/docs/superpowers/specs/2026-11-19-platform-status-design.md.
// Auth: header x-internal-key = WA_INTERNAL_KEY (the cron reads it from Vault: support_internal_key). No new keys.
// Flow: previous snapshot -> collect 15 items -> save (red_since first) -> mark the digest day -> send the messages.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { collect, type Figures } from "../_shared/status/collect.ts";
import { decide, recipients, STATUS_SUBJECT } from "../_shared/status/notify.ts";
import { ilDate, type Item } from "../_shared/status/levels.ts";
import { sendMail } from "../_shared/mail/send.ts";
import { supabaseMailDb } from "../_shared/mail/db.ts";
import { brandFor, safeEq } from "../_shared/mail/http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

async function get(url: string, gh = false): Promise<Response> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000),
    headers: gh ? { Accept: "application/vnd.github+json", "User-Agent": "yalla-sa-status" } : { "User-Agent": "yalla-sa-status" } });
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 80)}`);
  return r;
}
async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!safeEq(req.headers.get("x-internal-key") || "", Deno.env.get("WA_INTERNAL_KEY") || "")) return json({ error: "unauthorized" }, 401);
  // one run at a time: a second caller (cron + "בדיקה עכשיו" together) stops here instead of sending twice
  try { if (!(await rpc<boolean>("status_run_begin"))) return json({ ok: true, skipped: "running" }) }
  catch (e) { console.error("platform_status", String(e).slice(0, 300)); return json({ error: "internal" }, 500) }
  try {
    const now = new Date();
    const snap = await rpc<{ items: Item[]; last_digest_on: string | null; alert_emails: string[] | null }>("status_snapshot_get");
    const items = await collect({
      figures: () => rpc<Figures>("status_figures"),
      text: async (u) => (await get(u)).text(),
      json: async (u) => (await get(u, u.startsWith("https://api.github.com/"))).json(),
    }, snap.items, now);
    const d = decide(snap.items, items, now, snap.last_digest_on);
    // saved before sending: a second run right after (cron + "בדיקה עכשיו") sees red_since / the digest day and stays quiet
    await rpc("status_snapshot_put", { p_items: items, p_digest_on: d.markDigest ? ilDate(now) : null });
    // by email to the status list (private.status_meta.alert_emails), one mail per address; a failed send is logged
    // and does not stop the others. Counted in the mail quota like every alert (support_messages).
    const to = recipients(snap.alert_emails), apiKey = Deno.env.get("RESEND_API_KEY");
    const { data: s } = await admin.from("support_settings").select("mail_daily_cap").eq("id", 1).single();
    const send = async (kind: string, t: string) => {
      if (!to.length || !apiKey) { console.error("platform_status send", kind, !to.length ? "no_recipients" : "not_configured"); return }
      for (const addr of to) {
        try {
          const r = await sendMail({ db: supabaseMailDb(admin), fetch, apiKey, brand: brandFor(SUPABASE_URL), cap: s?.mail_daily_cap ?? 100 },
            { kind: "alert", to: addr, subject: STATUS_SUBJECT, body: t });
          if (!r.ok) console.error("platform_status send", kind, r.error || "failed");
        } catch (e) { console.error("platform_status send", kind, String(e).slice(0, 200)) }
      }
    };
    if (d.immediate) await send("immediate", d.immediate);
    if (d.digest) await send("digest", d.digest);
    return json({ ok: true, n: items.length, sent: { immediate: !!d.immediate, digest: !!d.digest } });
  } catch (e) {
    console.error("platform_status", String(e).slice(0, 300));
    return json({ error: "internal" }, 500);
  } finally {
    await admin.rpc("status_run_end").then(() => {}, () => {});
  }
});
