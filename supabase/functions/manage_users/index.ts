// manage_users: invite / list / change role / remove users of one operator (yalla-sa · נסיעות ריקות).
// Runs with the service role key (Edge Function env only; never in the browser or the repo).
// Caller must be a platform admin or an admin of that operator. Authenticated by the caller's own access token.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = "https://david-transit.github.io/deadhead-dashboard/";
const ORIGINS = ["https://david-transit.github.io", "http://localhost:8770", "http://127.0.0.1:8770"];
const ROLES = ["viewer", "editor", "admin"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const admin = createClient(SB_URL, SRK, { auth: { persistSession: false, autoRefreshToken: false } });

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const redirectOf = (r: unknown) =>
  typeof r === "string" && ORIGINS.some((o) => r.startsWith(o + "/")) && r.length < 300 ? r : SITE;

async function findUserByEmail(email: string) {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const u = data.users.find((x) => (x.email || "").toLowerCase() === email);
    if (u) return u;
    if (data.users.length < 1000) return null;
  }
  return null;
}

Deno.serve(async (req) => {
  const H = cors(req);
  const out = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...H, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "POST") return out({ error: "method" }, 405);

  // ---- who is calling ----
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return out({ error: "not_signed_in" }, 401);
  const { data: me, error: meErr } = await admin.auth.getUser(token);
  if (meErr || !me?.user) return out({ error: "not_signed_in" }, 401);
  const uid = me.user.id;

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return out({ error: "bad_input" }, 400); }
  const op = String(b.operator_id || "");
  if (!UUID.test(op)) return out({ error: "bad_input" }, 400);

  const { data: pa } = await admin.from("platform_admins").select("user_id").eq("user_id", uid).maybeSingle();
  const isPlatform = !!pa;
  if (!isPlatform) {
    const { data: m } = await admin.from("memberships").select("role").eq("user_id", uid).eq("operator_id", op).maybeSingle();
    if (m?.role !== "admin") return out({ error: "not_allowed" }, 403);
  }
  const { data: opRow } = await admin.from("operators").select("id").eq("id", op).maybeSingle();
  if (!opRow) return out({ error: "bad_input" }, 400);

  const memberOf = async (user: string) =>
    (await admin.from("memberships").select("role").eq("user_id", user).eq("operator_id", op).maybeSingle()).data;

  try {
    switch (b.action) {
      case "list": {
        const { data: ms, error } = await admin.from("memberships").select("user_id, role, created_at").eq("operator_id", op);
        if (error) throw error;
        const users = [];
        for (const m of ms || []) {
          const { data } = await admin.auth.admin.getUserById(m.user_id);
          const u = data?.user;
          users.push({
            user_id: m.user_id, role: m.role, email: u?.email || "?", added: m.created_at,
            last_sign_in: u?.last_sign_in_at || null, pending: !u?.last_sign_in_at, me: m.user_id === uid,
          });
        }
        users.sort((x, y) => x.email.localeCompare(y.email));
        return out({ ok: true, users });
      }

      case "invite": {
        const email = String(b.email || "").trim().toLowerCase();
        const role = String(b.role || "");
        if (!EMAIL.test(email) || !ROLES.includes(role)) return out({ error: "bad_input" }, 400);
        const redirectTo = redirectOf(b.redirect_to);
        let user = await findUserByEmail(email);
        let link: string | null = null, sent = false;
        if (!user) {
          await admin.rpc("allow_signup", { p_email: email }).throwOnError();
          if (b.send === "email") {
            const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
            if (error) return out({ error: "email_failed", detail: error.message }, 502);
            user = data.user; sent = true;
          } else {
            const { data, error } = await admin.auth.admin.generateLink({ type: "invite", email, options: { redirectTo } });
            if (error) throw error;
            user = data.user; link = data.properties.action_link;
          }
        }
        if (await memberOf(user!.id)) return out({ error: "already_member" }, 409);
        await admin.from("memberships").insert({ user_id: user!.id, operator_id: op, role, created_by: uid }).throwOnError();
        return out({ ok: true, user_id: user!.id, existing: !sent && !link, sent, link });
      }

      case "link": { // a fresh sign-in link for a member who never signed in (or anyone, for a platform admin)
        const target = String(b.user_id || "");
        if (!UUID.test(target) || !(await memberOf(target))) return out({ error: "bad_input" }, 400);
        const { data: tu } = await admin.auth.admin.getUserById(target);
        if (!tu?.user?.email) return out({ error: "bad_input" }, 400);
        if (tu.user.last_sign_in_at && !isPlatform) return out({ error: "already_active" }, 409);
        const { data, error } = await admin.auth.admin.generateLink({
          type: "recovery", email: tu.user.email, options: { redirectTo: redirectOf(b.redirect_to) },
        });
        if (error) throw error;
        return out({ ok: true, link: data.properties.action_link });
      }

      case "set_role": {
        const target = String(b.user_id || ""), role = String(b.role || "");
        if (!UUID.test(target) || !ROLES.includes(role)) return out({ error: "bad_input" }, 400);
        if (target === uid && !isPlatform) return out({ error: "not_self" }, 400);
        if (!(await memberOf(target))) return out({ error: "bad_input" }, 400);
        await admin.from("memberships").update({ role }).eq("user_id", target).eq("operator_id", op).throwOnError();
        return out({ ok: true });
      }

      case "remove": {
        const target = String(b.user_id || "");
        if (!UUID.test(target)) return out({ error: "bad_input" }, 400);
        if (target === uid && !isPlatform) return out({ error: "not_self" }, 400);
        if (!(await memberOf(target))) return out({ error: "bad_input" }, 400);
        await admin.from("memberships").delete().eq("user_id", target).eq("operator_id", op).throwOnError();
        // no access left anywhere -> delete the login too
        const { count } = await admin.from("memberships").select("*", { count: "exact", head: true }).eq("user_id", target);
        const { data: tpa } = await admin.from("platform_admins").select("user_id").eq("user_id", target).maybeSingle();
        let deleted = false;
        if (!count && !tpa) { await admin.auth.admin.deleteUser(target); deleted = true; }
        return out({ ok: true, deleted });
      }

      default:
        return out({ error: "bad_input" }, 400);
    }
  } catch (e) {
    console.error("manage_users", b.action, e);
    return out({ error: "server_error" }, 500);
  }
});
