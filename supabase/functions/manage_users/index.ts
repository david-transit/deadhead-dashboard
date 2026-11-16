// manage_users (yalla-sa · נסיעות ריקות): username + password accounts, no email ever sent.
// Supabase Auth holds each user under an internal address <username>@users.yalla-sa.app (never shown).
// Runs with the service role key (Edge Function env only; never in the browser or the repo).
//
// No sign-in needed:   bootstrap_status, bootstrap (first platform admin, once, server-enforced)
// Signed-in user:      change_password (own; clears must_change_password)
// Control room:        list, create, set_membership, remove_membership, reset_password, set_disabled, delete
//   platform admin = every user except other platform admins; operator admin = users whose access is only
//   in operators he administers.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "sb_publishable_hCBsqYekz61JY6SFfT_sjw_-wj0QGXT"; // public key
const DOMAIN = "users.yalla-sa.app";
const ORIGINS = ["https://david-transit.github.io", "http://localhost:8770", "http://127.0.0.1:8770"];
const ROLES = ["viewer", "editor", "admin"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER = /^[a-z0-9._-]{3,32}$/;

const admin = createClient(SB_URL, SRK, { auth: { persistSession: false, autoRefreshToken: false } });
const emailOf = (u: string) => `${u}@${DOMAIN}`;
const cleanUser = (u: unknown) => String(u ?? "").trim().toLowerCase();
const okPw = (p: unknown) => typeof p === "string" && p.length >= 8 && p.length <= 72;
const cleanName = (n: unknown) => String(n ?? "").trim().slice(0, 80);

class Fail extends Error { constructor(public code: string, public status = 400) { super(code); } }

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

async function createAccount(username: string, password: string, display_name: string, must_change: boolean, by: string | null) {
  const { data: taken } = await admin.from("profiles").select("user_id").eq("username", username).maybeSingle();
  if (taken) throw new Fail("username_taken", 409);
  await admin.rpc("allow_signup", { p_email: emailOf(username) }).throwOnError();
  const { data, error } = await admin.auth.admin.createUser({
    email: emailOf(username), password, email_confirm: true, user_metadata: { username },
  });
  if (error || !data.user) {
    if (/already/i.test(error?.message || "")) throw new Fail("username_taken", 409);
    if (/password/i.test(error?.message || "")) throw new Fail("weak_password");
    throw error || new Error("create failed");
  }
  const id = data.user.id;
  const { error: pe } = await admin.from("profiles").insert({ user_id: id, username, display_name, must_change_password: must_change, created_by: by });
  if (pe) { await admin.auth.admin.deleteUser(id); throw pe; }
  return id;
}

Deno.serve(async (req) => {
  const H = cors(req);
  const out = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...H, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "POST") return out({ error: "method" }, 405);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return out({ error: "bad_input" }, 400); }

  try {
    // ---------- no sign-in ----------
    if (b.action === "bootstrap_status") {
      const { data } = await admin.rpc("bootstrap_needed").throwOnError();
      return out({ ok: true, needed: !!data });
    }
    if (b.action === "bootstrap") {
      const username = cleanUser(b.username), name = cleanName(b.display_name);
      if (!USER.test(username)) throw new Fail("bad_username");
      if (!okPw(b.password)) throw new Fail("weak_password");
      const { data: claimed } = await admin.rpc("claim_bootstrap").throwOnError();
      if (!claimed) throw new Fail("bootstrap_done", 409);
      try {
        const id = await createAccount(username, b.password as string, name, false, null);
        await admin.from("platform_admins").insert({ user_id: id }).throwOnError();
        return out({ ok: true });
      } catch (e) {
        await admin.rpc("release_bootstrap");
        throw e;
      }
    }

    // ---------- who is calling ----------
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) throw new Fail("not_signed_in", 401);
    const { data: me, error: meErr } = await admin.auth.getUser(token);
    if (meErr || !me?.user) throw new Fail("not_signed_in", 401);
    const uid = me.user.id;
    const { data: myProf } = await admin.from("profiles").select("username, must_change_password, disabled").eq("user_id", uid).maybeSingle();
    if (myProf?.disabled) throw new Fail("disabled", 403);

    if (b.action === "change_password") {
      if (!myProf) throw new Fail("not_allowed", 403);
      if (!okPw(b.new_password)) throw new Fail("weak_password");
      if (b.new_password === b.current_password) throw new Fail("same_password");
      const check = createClient(SB_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: se } = await check.auth.signInWithPassword({ email: emailOf(myProf.username), password: String(b.current_password ?? "") });
      if (se) throw new Fail("wrong_password", 403);
      await check.auth.signOut({ scope: "local" }).catch(() => {}); // only the check session, not the caller's
      const { error } = await admin.auth.admin.updateUserById(uid, { password: b.new_password as string });
      if (error) throw new Fail(/password/i.test(error.message) ? "weak_password" : "server_error", 400);
      await admin.from("profiles").update({ must_change_password: false }).eq("user_id", uid).throwOnError();
      return out({ ok: true });
    }

    // ---------- control room ----------
    if (!myProf || myProf.must_change_password) throw new Fail("not_allowed", 403);
    const { data: pa } = await admin.from("platform_admins").select("user_id");
    const platformIds = new Set((pa || []).map((x) => x.user_id));
    const isPlatform = platformIds.has(uid);
    const { data: mine } = await admin.from("memberships").select("operator_id").eq("user_id", uid).eq("role", "admin");
    const adminOps = new Set((mine || []).map((x) => x.operator_id));
    if (!isPlatform && !adminOps.size) throw new Fail("not_allowed", 403);
    const canOp = (op: string) => isPlatform || adminOps.has(op);
    const membershipsOf = async (user: string) =>
      (await admin.from("memberships").select("operator_id, role").eq("user_id", user)).data || [];
    // may the caller reset / disable / delete / re-assign this user?
    const manageable = async (target: string) => {
      if (!UUID.test(target) || target === uid || platformIds.has(target)) return false;
      if (isPlatform) return true;
      const ms = await membershipsOf(target);
      return ms.length > 0 && ms.every((m) => adminOps.has(m.operator_id));
    };
    const needTarget = async () => {
      const t = String(b.user_id || "");
      if (!(await manageable(t))) throw new Fail("not_allowed", 403);
      const { data } = await admin.from("profiles").select("user_id").eq("user_id", t).maybeSingle();
      if (!data) throw new Fail("bad_input");
      return t;
    };
    const needOpRole = () => {
      const op = String(b.operator_id || ""), role = String(b.role || "");
      if (!UUID.test(op) || !ROLES.includes(role)) throw new Fail("bad_input");
      if (!canOp(op)) throw new Fail("not_allowed", 403);
      return { op, role };
    };

    switch (b.action) {
      case "list": {
        const { data: profs } = await admin.from("profiles").select("user_id, username, display_name, must_change_password, disabled, created_at");
        const { data: ms } = await admin.from("memberships").select("user_id, operator_id, role");
        const seen = new Map<string, string>();
        for (let page = 1; page < 20; page++) {
          const { data } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
          for (const u of data?.users || []) seen.set(u.id, u.last_sign_in_at || "");
          if (!data || data.users.length < 1000) break;
        }
        const users = [];
        for (const p of profs || []) {
          const all = (ms || []).filter((m) => m.user_id === p.user_id);
          const visible = isPlatform ? all : all.filter((m) => adminOps.has(m.operator_id));
          if (!isPlatform && !visible.length && p.user_id !== uid) continue;
          users.push({
            user_id: p.user_id, username: p.username, display_name: p.display_name, disabled: p.disabled,
            must_change: p.must_change_password, last_sign_in: seen.get(p.user_id) || null,
            memberships: visible.map((m) => ({ operator_id: m.operator_id, role: m.role })),
            other_access: all.length > visible.length, platform: platformIds.has(p.user_id),
            me: p.user_id === uid, manageable: await manageable(p.user_id),
          });
        }
        users.sort((x, y) => x.username.localeCompare(y.username));
        return out({ ok: true, users, platform: isPlatform });
      }

      case "create": {
        const username = cleanUser(b.username);
        if (!USER.test(username)) throw new Fail("bad_username");
        if (!okPw(b.password)) throw new Fail("weak_password");
        const { op, role } = needOpRole();
        const id = await createAccount(username, b.password as string, cleanName(b.display_name), true, uid);
        await admin.from("memberships").insert({ user_id: id, operator_id: op, role, created_by: uid }).throwOnError();
        return out({ ok: true, user_id: id });
      }

      case "set_membership": {
        const t = await needTarget(), { op, role } = needOpRole();
        await admin.from("memberships").upsert({ user_id: t, operator_id: op, role, created_by: uid }, { onConflict: "user_id,operator_id" }).throwOnError();
        return out({ ok: true });
      }

      case "remove_membership": {
        const t = await needTarget(), op = String(b.operator_id || "");
        if (!UUID.test(op) || !canOp(op)) throw new Fail("not_allowed", 403);
        await admin.from("memberships").delete().eq("user_id", t).eq("operator_id", op).throwOnError();
        return out({ ok: true });
      }

      case "reset_password": {
        const t = await needTarget();
        if (!okPw(b.password)) throw new Fail("weak_password");
        const { error } = await admin.auth.admin.updateUserById(t, { password: b.password as string });
        if (error) throw new Fail(/password/i.test(error.message) ? "weak_password" : "server_error");
        await admin.from("profiles").update({ must_change_password: true }).eq("user_id", t).throwOnError();
        return out({ ok: true });
      }

      case "set_disabled": {
        const t = await needTarget(), off = !!b.disabled;
        const { error } = await admin.auth.admin.updateUserById(t, { ban_duration: off ? "876000h" : "none" });
        if (error) throw error;
        await admin.from("profiles").update({ disabled: off }).eq("user_id", t).throwOnError();
        return out({ ok: true });
      }

      case "delete": {
        const t = await needTarget();
        const { error } = await admin.auth.admin.deleteUser(t);
        if (error) throw error;
        return out({ ok: true });
      }

      default:
        throw new Fail("bad_input");
    }
  } catch (e) {
    if (e instanceof Fail) return out({ error: e.code }, e.status);
    console.error("manage_users", b.action, e);
    return out({ error: "server_error" }, 500);
  }
});
