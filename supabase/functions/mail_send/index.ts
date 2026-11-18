// mail_send (yalla-sa support): the only door to send mail from support@yalla-sa.app.
// Spec: yalla-sa-support/docs/superpowers/specs/2026-11-18-email-design.md §3
// Callers:
//   * support agent (browser, /support/): JWT of a user in support_agents, session aal2 (personal data).
//       {action:"reply", conversation, body}
//   * server (sendAlert, support_jobs): header x-internal-key = WA_INTERNAL_KEY (never in a browser).
//       {action:"alert", to, subject, body}  -> 200 {ok:true,id} | {ok:true,queued:true}
// Errors: {ok:false,error:"quota"|"send_failed"|"bad_input"|"not_allowed"|...}
// Secrets (typed by David): RESEND_API_KEY, WA_INTERNAL_KEY.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { sendMail, type MailDeps } from "../_shared/mail/send.ts";
import { supabaseMailDb } from "../_shared/mail/db.ts";
import { brandFor, claimsOf, safeEq, Fail, EMAIL_RE } from "../_shared/mail/http.ts";
import { alerter } from "../_shared/mail/alert.ts";

const ORIGINS = ["https://yalla-sa.app"];
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } });
const db = supabaseMailDb(admin);

async function deps(): Promise<MailDeps> {
  const { data: s } = await admin.from("support_settings").select("mail_daily_cap").eq("id", 1).single();
  // the 80% warning goes on the chosen alert channel (WhatsApp or mail); warn=false so it cannot warn about itself
  return { db, fetch, apiKey: Deno.env.get("RESEND_API_KEY")!, brand: brandFor(SUPABASE_URL), cap: s?.mail_daily_cap ?? 100,
    alert: alerter(admin, SUPABASE_URL, false) };
}

Deno.serve(async (req) => {
  const o = req.headers.get("origin") || "";
  const H = { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], Vary: "Origin",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...H, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "POST") return out({ ok: false, error: "method" }, 405);
  if (!Deno.env.get("RESEND_API_KEY")) return out({ ok: false, error: "not_configured" }, 503);

  try {
    const b = await req.json().catch(() => { throw new Fail("bad_input"); });

    const ik = req.headers.get("x-internal-key") || "";
    if (ik) {
      if (!safeEq(ik, Deno.env.get("WA_INTERNAL_KEY") || "")) throw new Fail("unauthorized", 401);
      const to = String(b.to || "").trim().toLowerCase(), subject = String(b.subject || "").trim().slice(0, 200);
      const body = String(b.body || "").trim().slice(0, 10000);
      if (b.action !== "alert" || !EMAIL_RE.test(to) || !subject || !body) throw new Fail("bad_input");
      const r = await sendMail(await deps(), { kind: "alert", to, subject, body });
      return out(r, r.ok ? 200 : 422);
    }

    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: me } = await admin.auth.getUser(jwt);
    if (!me?.user) throw new Fail("unauthorized", 401);
    if (claimsOf(jwt).aal !== "aal2") throw new Fail("mfa_required", 403);
    const { data: agent } = await admin.from("support_agents").select("user_id").eq("user_id", me.user.id).maybeSingle();
    if (!agent) throw new Fail("not_allowed", 403);

    if (b.action === "reply") {
      const body = String(b.body || "").trim().slice(0, 20000);
      if (!body || typeof b.conversation !== "string") throw new Fail("bad_input");
      const r = await sendMail(await deps(), { kind: "reply", conversationId: b.conversation, body, agentId: me.user.id })
        .catch((e) => { if (String(e?.message) === "not_found") throw new Fail("not_found", 404); throw e; });
      return out(r, r.ok ? 200 : 422);
    }
    throw new Fail("bad_input");
  } catch (e) {
    if (e instanceof Fail) return out({ ok: false, error: e.code }, e.status);
    console.error("mail_send", String(e).slice(0, 500));
    return out({ ok: false, error: "internal" }, 500);
  }
});
