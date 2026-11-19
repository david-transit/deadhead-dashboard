// mail_inbound (yalla-sa support): mail that reached support@yalla-sa.app, sent here by the Cloudflare Email Worker
// (cloudflare/mail-worker). Spec: yalla-sa-support/docs/superpowers/specs/2026-11-18-email-design.md §3 "קליטה".
// Auth: header x-mail-key = MAIL_INBOUND_KEY (typed by David in Supabase and in Cloudflare). No browser caller.
//   content-type message/rfc822  -> the raw mail
//   application/json {oversize:true, from, subject, size} -> the Worker sent a >12MB mail to the backup Gmail
// 200 = stored or deliberately dropped (the Worker is done). Any other status = the Worker forwards to the backup Gmail.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import PostalMime from "npm:postal-mime@2.4.4";
import { classify } from "../_shared/mail/parse.ts";
import { handleMail, handleOversize } from "../_shared/mail/inbound.ts";
import { supabaseInboundDb } from "../_shared/mail/inbound_db.ts";
import { alerter } from "../_shared/mail/alert.ts";
import { safeEq } from "../_shared/mail/http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } });
const deps = { db: supabaseInboundDb(admin), alert: alerter(admin, SUPABASE_URL) };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const key = Deno.env.get("MAIL_INBOUND_KEY") || "";
  if (!key || !safeEq(req.headers.get("x-mail-key") || "", key)) return json({ error: "unauthorized" }, 401);

  try {
    const ct = (req.headers.get("content-type") || "").toLowerCase();
    if (ct.startsWith("application/json")) {
      const b = await req.json();
      if (!b?.oversize || typeof b.from !== "string") return json({ error: "bad_input" }, 400);
      await handleOversize(deps, { from: b.from, subject: typeof b.subject === "string" ? b.subject : null, size: Number(b.size) || 0 });
      return json({ ok: true });
    }
    const parsed = await PostalMime.parse(await req.arrayBuffer(), { attachmentEncoding: "arraybuffer" });
    const r = await handleMail(deps, classify(parsed as any));
    if (!r.stored) console.log("mail_inbound dropped", r.reason); // no address, no subject: a counter only (M16)
    return json({ ok: true, ...r });
  } catch (e) {
    console.error("mail_inbound", String(e).slice(0, 300));
    await deps.alert("תקלה בקליטת מייל. המייל הועבר לתיבה הטכנית").catch(() => {});
    return json({ error: "internal" }, 500);
  }
});
