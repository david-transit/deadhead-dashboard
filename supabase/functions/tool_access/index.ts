// tool_access (yalla-sa): server-to-server lookup of what a portal user may do in a tool on another domain.
// The portal's control panel is the ONLY place where access is managed; tools keep no user management of their own.
// Caller: transit-studio's server (app.yalla-sa.app), after verifying the Cloudflare Access JWT, whose custom.sub is the
// Supabase user id (Access login method "yalla-sa" = this project's OAuth server; docs: unified-gate-access-oidc.md).
//
// Contract (agreed with the yalla-sa architect, 2026-11-18; the body may change, the contract may not):
//   POST {"user_id": "<uuid>", "module": "transit-studio"}   header x-internal-key: <TOOL_ACCESS_KEY>
//   200  {"active": bool, "username", "display_name", "platform_admin": bool,
//         "roles": [{"operator_id", "operator_name", "role": "viewer"|"editor"|"admin"}]}
//        unknown, deleted or disabled user -> {"active": false, ...empty}: never a 404 that tells the user exists.
//   Tool rule: platform_admin = full access; otherwise no roles = no entry. The tool fails closed (503) if this is down.
//   401 bad/missing key · 400 bad request · 405 not POST · 503 key not configured on the server (fails closed).
// Source of roles: tool_roles for the caller's module (transit-studio -> 'studio') + platform_admins. Since 2026-11-19 the
// role in each tool is separate (migration 20261119120000_tool_roles.sql); memberships.role is the deadhead tool's only.
// When membership_modules is approved (docs/identity-migration.sql) only the body changes again.
// The key is a Supabase secret (TOOL_ACCESS_KEY), set by David; it is never logged, echoed or stored in the repo.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { CALLER_MODULE, rolesForModule } from "../_shared/access.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const admin = createClient(SB_URL, SRK, { auth: { persistSession: false, autoRefreshToken: false } });

const J = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const NONE = { active: false, username: null, display_name: null, platform_admin: false, roles: [] };

// constant-time comparison over SHA-256 digests (equal length whatever the input)
async function sameKey(given: string, expected: string) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, expected].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

Deno.serve(async (req) => {
  // server-to-server only: no CORS headers, so a browser page cannot read the answer
  if (req.method !== "POST") return J({ error: "method_not_allowed" }, 405);
  const KEY = Deno.env.get("TOOL_ACCESS_KEY") || "";
  if (KEY.length < 32) return J({ error: "not_configured" }, 503);
  if (!(await sameKey(req.headers.get("x-internal-key") || "", KEY))) return J({ error: "unauthorized" }, 401);

  let b: { user_id?: unknown; module?: unknown };
  try { b = await req.json() } catch { return J({ error: "bad_request" }, 400) }
  const uid = String(b?.user_id ?? ""), mod = String(b?.module ?? "");
  if (!UUID.test(uid) || !Object.hasOwn(CALLER_MODULE, mod)) return J({ error: "bad_request" }, 400);

  try {
    const [pr, pa, tr, ops] = await Promise.all([
      admin.from("profiles").select("username, display_name, disabled").eq("user_id", uid).maybeSingle().throwOnError(),
      admin.from("platform_admins").select("user_id").eq("user_id", uid).maybeSingle().throwOnError(),
      admin.from("tool_roles").select("operator_id, module, role").eq("user_id", uid).eq("module", CALLER_MODULE[mod]).throwOnError(),
      admin.from("operators").select("id, name").throwOnError(),
    ]);
    const p = pr.data;
    if (!p || p.disabled) return J(NONE);
    // a deleted or banned Auth user is not active either
    const { data: au, error: ae } = await admin.auth.admin.getUserById(uid);
    if (ae || !au?.user) return J(NONE);
    const bu = (au.user as { banned_until?: string | null }).banned_until;
    if (bu && Date.parse(bu) > Date.now()) return J(NONE);
    const opName = new Map((ops.data || []).map((o: { id: string; name: string }) => [o.id, o.name]));
    const roles = rolesForModule(tr.data || [], CALLER_MODULE[mod])
      .map((g) => ({ operator_id: g.operator_id, operator_name: opName.get(g.operator_id) ?? null, role: g.role }));
    return J({ active: true, username: p.username, display_name: p.display_name || p.username, platform_admin: !!pa.data, roles });
  } catch (e) {
    console.error("tool_access lookup failed", (e as Error)?.message); // no key, no user data
    return J({ error: "server_error" }, 500);
  }
});
