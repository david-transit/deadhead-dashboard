// support_push (yalla-sa support, PRD-email M20; design 2026-11-22-email-push-alerts-design.md §5).
// A signed-in support agent registers or removes this device for push alerts, or sends a test to own devices.
//   {action:"subscribe", endpoint, keys:{p256dh,auth}, label} | {action:"unsubscribe", endpoint} | {action:"test"}
// aal2 is not required: the function reveals nothing (like support_is_agent). Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { pushAction } from "../_shared/push_api.ts";
import { pushToAgents } from "../_shared/push.ts";
import { vapidKeys } from "../_shared/push_db.ts";

const ORIGINS = ["https://yalla-sa.app"];
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } });
const must = async (q: PromiseLike<{ error: unknown }>) => { const { error } = await q; if (error) throw error; };

const deps = {
  async isAgent(uid: string) {
    const { data } = await admin.from("support_agents").select("user_id").eq("user_id", uid).maybeSingle();
    return !!data;
  },
  upsert: (r: Record<string, unknown>) => must(admin.from("support_push_subs").upsert(r, { onConflict: "endpoint" })),
  remove: (uid: string, ep: string) => must(admin.from("support_push_subs").delete().eq("user_id", uid).eq("endpoint", ep)),
  sendOwn: (uid: string, text: string) => pushToAgents({
    async list() {
      const { data, error } = await admin.from("support_push_subs").select("id, endpoint, p256dh, auth").eq("user_id", uid);
      if (error) throw error; return data ?? [];
    },
    remove: (ids) => must(admin.from("support_push_subs").delete().in("id", ids)),
  }, text, vapidKeys()),
};

Deno.serve(async (req) => {
  const o = req.headers.get("origin") || "";
  const H = { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], Vary: "Origin",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...H, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "POST") return out({ ok: false, error: "method" }, 405);
  try {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: me } = await admin.auth.getUser(jwt);
    if (!me?.user) return out({ ok: false, error: "unauthorized" }, 401);
    const b = await req.json().catch(() => null);
    const { status, ...r } = await pushAction(deps, me.user.id, b);
    return out(r, status ?? 200);
  } catch (e) {
    console.error("support_push", String(e).slice(0, 300));
    return out({ ok: false, error: "internal" }, 500);
  }
});
