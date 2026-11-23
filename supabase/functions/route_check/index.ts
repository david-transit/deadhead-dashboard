// route_check (R51 live check, David 23.11.2026): "בדיקה עכשיו" in the dashboard's route warnings list.
// POST {"operator_id", "a": [lat, lon], "b": [lat, lon]}  Authorization: Bearer <the user's token>
// 200 {"ok": true, "km": <Google's km, 1 decimal> | null}  · 400 bad_input · 401 not signed in · 403 not_allowed
// 429 quota · 502 google_error · 503 not_configured (GOOGLE_ROUTES_API_KEY missing).
// Logic and the rules on what is never kept: ../_shared/route_check.ts. Nothing from Google is logged here either:
// on failure only the error's type is printed. The key is a Supabase secret, set by David; never in the repo.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { check } from "../_shared/route_check.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const ORIGINS = ["https://david-transit.github.io", "https://yalla-sa.app"];

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const H = { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" };
  const out = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: H });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return out({ error: "method" }, 405);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return out({ error: "not_signed_in" }, 401);
  const { data: me, error: meErr } = await admin.auth.getUser(token);
  if (meErr || !me?.user) return out({ error: "not_signed_in" }, 401);
  let body: unknown;
  try { body = await req.json(); } catch { return out({ error: "bad_input" }, 400); }
  // the caller's own client: RLS / auth.uid() see the caller, not the service role
  const asUser = createClient(SB_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } } });
  try {
    const r = await check(body, {
      key: (Deno.env.get("GOOGLE_ROUTES_API_KEY") || "").trim(),
      allowed: async (op) => {
        const { data, error } = await asUser.rpc("can_verify_route", { p_operator: op });
        return !error && data === true;
      },
      take: async (c) => {
        const { data, error } = await admin.rpc("google_take", { month_cap: c.month, day_cap: c.day });
        if (error) throw error;
        return data === true;
      },
      post: async (url, b, headers) => {
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(b), signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error("google_http_" + res.status);
        return await res.json();
      },
    });
    return out(r.body, r.status);
  } catch (e) {
    console.error("route_check failed", (e as Error)?.name || "error"); // no key, no coordinates, no Google value
    return out({ error: "server_error" }, 500);
  }
});
