// wa_send (yalla-sa support): the only door to send WhatsApp messages. Spec: yalla-sa-support/docs/superpowers/specs/2026-11-18-whatsapp-design.md
// Callers:
//   * support agent (browser, /support/): JWT of a user in support_agents, session aal2 (personal data).
//       {action:"reply", conversation, body}   free text inside the 24h window
//       {action:"resend", message}             a failed outgoing text message again
//       multipart/form-data action=file, conversation, file   an agent's file (PRD R7א); forwarded to Meta, no copy kept
//   * server (manage_users, portal login code): header x-internal-key = WA_INTERNAL_KEY (never in a browser).
//       {action:"template", to, template, params, quickReply?}   template name must be in TEMPLATES
// Secrets (Edge Function env, typed by David): WA_TOKEN, WA_PHONE_ID, WA_INTERNAL_KEY.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { sendMessage } from "../_shared/send.ts";
import { mediaKind, normPhone, type Category } from "../_shared/rules.ts";
import { mediaUpload } from "../_shared/meta.ts";
import { supabaseDb } from "../_shared/db.ts";

const ORIGINS = ["https://yalla-sa.app"];
// login_code_v1 (authentication) is added when its copy-code button payload and the aal2 question are settled (review I9)
const TEMPLATES: Record<string, Category> = { welcome_v1: "utility", alert_v1: "utility" };
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } });
const db = supabaseDb(admin);

class Fail extends Error { constructor(public code: string, public status = 400) { super(code); } }
function claimsOf(t: string): Record<string, unknown> { // only after admin.auth.getUser accepted the token
  try { return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return {}; }
}
function safeEq(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}

Deno.serve(async (req) => {
  const o = req.headers.get("origin") || "";
  const H = { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], Vary: "Origin",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...H, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "POST") return out({ error: "method" }, 405);

  const token = Deno.env.get("WA_TOKEN"), phoneId = Deno.env.get("WA_PHONE_ID");
  if (!token || !phoneId) return out({ error: "not_configured" }, 503);
  const deps = { db, cfg: { token, phoneId } };

  try {
    const isForm = (req.headers.get("content-type") || "").startsWith("multipart/form-data");
    const form = isForm ? await req.formData().catch(() => { throw new Fail("bad_input"); }) : null;
    const b = form ? Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"))
      : await req.json().catch(() => { throw new Fail("bad_input"); });

    // server-to-server: templates only
    const ik = req.headers.get("x-internal-key") || "";
    if (ik) {
      if (!safeEq(ik, Deno.env.get("WA_INTERNAL_KEY") || "")) throw new Fail("unauthorized", 401);
      if (b.action !== "template" || !TEMPLATES[b.template]) throw new Fail("bad_input");
      const to = normPhone(String(b.to || ""));
      if (!to) throw new Fail("bad_phone");
      const params = Array.isArray(b.params) ? b.params.map((x: unknown) => String(x).slice(0, 500)) : [];
      const r = await sendMessage(deps, { to, kind: "template", template: b.template, params,
        quickReply: b.template === "welcome_v1" ? "הסר" : undefined, category: TEMPLATES[b.template], sender: "system" });
      return out(r, r.ok ? 200 : 422);
    }

    // support agent from the browser
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: me } = await admin.auth.getUser(jwt);
    if (!me?.user) throw new Fail("unauthorized", 401);
    if (claimsOf(jwt).aal !== "aal2") throw new Fail("mfa_required", 403);
    const { data: agent } = await admin.from("support_agents").select("user_id").eq("user_id", me.user.id).maybeSingle();
    if (!agent) throw new Fail("not_allowed", 403);
    // same bar as RLS (private.is_support_agent → is_active): a disabled user or one who must change the password cannot send
    const { data: prof } = await admin.from("profiles").select("disabled, must_change_password").eq("user_id", me.user.id).maybeSingle();
    if (!prof || prof.disabled || prof.must_change_password) throw new Fail("not_allowed", 403);

    if (b.action === "reply") {
      const body = String(b.body || "").trim().slice(0, 4096);
      if (!body) throw new Fail("bad_input");
      const { data: cv } = await admin.from("support_conversations").select("id, status, assignee, support_contacts(wa_id)")
        .eq("id", b.conversation).maybeSingle();
      if (!cv) throw new Fail("not_found", 404);
      const r = await sendMessage(deps, { to: cv.support_contacts.wa_id, kind: "text", body, category: "service",
        sender: "agent", agentId: me.user.id, conversationId: cv.id });
      if (r.ok && (cv.status !== "assigned" || !cv.assignee)) {
        await admin.from("support_conversations").update({ status: "assigned", assignee: cv.assignee ?? me.user.id }).eq("id", cv.id);
      }
      return out(r, r.ok ? 200 : 422);
    }
    if (b.action === "file" && form) {
      const file = form.get("file");
      if (!(file instanceof File)) throw new Fail("bad_input");
      const mk = mediaKind(file.type, file.size);
      if ("error" in mk) return out(mk, 413);
      const { data: cv } = await admin.from("support_conversations").select("id, support_contacts(wa_id)").eq("id", b.conversation).maybeSingle();
      if (!cv) throw new Fail("not_found", 404);
      const filename = String(file.name || "file").slice(0, 200);
      const mediaId = await mediaUpload(file, filename, deps.cfg);
      const r = await sendMessage(deps, { to: cv.support_contacts.wa_id, kind: "media",
        media: { kind: mk.kind, id: mediaId, filename, size: file.size }, category: "service",
        sender: "agent", agentId: me.user.id, conversationId: cv.id });
      return out(r, r.ok ? 200 : 422);
    }
    if (b.action === "resend") {
      const { data: m } = await admin.from("support_messages").select("id, body, template, status, direction, conversation_id, support_contacts(wa_id)")
        .eq("id", b.message).maybeSingle();
      if (!m || m.status !== "failed" || m.direction !== "out" || m.template) throw new Fail("bad_input");
      const r = await sendMessage(deps, { to: m.support_contacts.wa_id, kind: "text", body: m.body, category: "service",
        sender: "agent", agentId: me.user.id, conversationId: m.conversation_id });
      return out(r, r.ok ? 200 : 422);
    }
    throw new Fail("bad_input");
  } catch (e) {
    if (e instanceof Fail) return out({ error: e.code }, e.status);
    console.error(e);
    return out({ error: "server_error" }, 500);
  }
});
