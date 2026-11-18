// support_jobs (yalla-sa support): background jobs, called by pg_cron through pg_net (migration 20261120091000).
// Spec: yalla-sa-support/docs/superpowers/specs/2026-11-18-email-design.md §3 "משימות רקע".
// Auth: header x-internal-key = WA_INTERNAL_KEY (the cron reads it from Vault: support_internal_key). Body: {job}
//   reminders  every 15 min: conversations waiting > 24 business hours -> one alert each (both channels, no name)
//   queued     hourly: mail alerts kept back by the daily quota
//   files      daily 03:00: attachment folders whose conversation was deleted (retention, M17)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { runReminders, flushQueued, cleanupFiles } from "../_shared/jobs.ts";
import { supabaseJobsDb, supabaseMailDb } from "../_shared/mail/db.ts";
import { sendMail } from "../_shared/mail/send.ts";
import { alerter } from "../_shared/mail/alert.ts";
import { brandFor, safeEq } from "../_shared/mail/http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } });
const db = supabaseJobsDb(admin);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!safeEq(req.headers.get("x-internal-key") || "", Deno.env.get("WA_INTERNAL_KEY") || "")) return json({ error: "unauthorized" }, 401);
  try {
    const { job } = await req.json();
    const { data: s } = await admin.from("support_settings").select("hours, mail_daily_cap").eq("id", 1).single();
    if (job === "reminders") return json({ ok: true, n: await runReminders({ db, hours: s.hours, alert: alerter(admin, SUPABASE_URL) }, new Date()) });
    if (job === "queued") {
      const apiKey = Deno.env.get("RESEND_API_KEY");
      if (!apiKey) return json({ ok: true, n: 0, note: "not_configured" });
      const d = { db: supabaseMailDb(admin), fetch, apiKey, brand: brandFor(SUPABASE_URL), cap: s.mail_daily_cap ?? 100,
        alert: alerter(admin, SUPABASE_URL, false) };
      return json({ ok: true, n: await flushQueued({ db, send: (r) => sendMail(d, r) }) });
    }
    if (job === "files") return json({ ok: true, n: await cleanupFiles({ db }) });
    return json({ error: "bad_input" }, 400);
  } catch (e) {
    console.error("support_jobs", String(e).slice(0, 300));
    return json({ error: "internal" }, 500);
  }
});
