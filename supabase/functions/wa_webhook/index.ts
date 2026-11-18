// wa_webhook (yalla-sa support): Meta -> us. Deploy with verify_jwt = false (Meta sends no Supabase JWT);
// every POST is authenticated by Meta's signature instead. Spec §1, §6.
//   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…   one-time subscription check
//   POST X-Hub-Signature-256 over the raw body; answered 200 at once, the work runs after the response.
// Secrets: WA_APP_SECRET, WA_VERIFY_TOKEN, WA_TOKEN, WA_PHONE_ID.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { parseWebhook, verifySignature } from "../_shared/meta.ts";
import { handleInbound } from "../_shared/inbound.ts";
import { supabaseDb } from "../_shared/db.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } });
const db = supabaseDb(admin);
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && !!Deno.env.get("WA_VERIFY_TOKEN") &&
      url.searchParams.get("hub.verify_token") === Deno.env.get("WA_VERIFY_TOKEN");
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 }) : new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const raw = await req.text();
  if (!await verifySignature(raw, req.headers.get("x-hub-signature-256"), Deno.env.get("WA_APP_SECRET") || "")) {
    return new Response("unauthorized", { status: 401 });
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return new Response("bad", { status: 400 }); }
  const token = Deno.env.get("WA_TOKEN"), phoneId = Deno.env.get("WA_PHONE_ID");
  if (!token || !phoneId) return new Response("not_configured", { status: 503 });

  EdgeRuntime.waitUntil(handleInbound({ db, cfg: { token, phoneId } }, parseWebhook(json)).catch((e) => console.error("wa_webhook", e)));
  return new Response("ok", { status: 200 });
});
