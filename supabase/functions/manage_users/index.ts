// manage_users (yalla-sa · נסיעות ריקות): username + password accounts, no email ever sent.
// Supabase Auth holds each user under an internal address <username>@users.yalla-sa.app (never shown).
// Runs with the service role key (Edge Function env only; never in the browser or the repo).
//
// No sign-in needed:   bootstrap_status, bootstrap (first platform admin, once, server-enforced),
//                      sign_in (username -> accounts whose Auth email is a real recovery address),
//                      recovery_options, forgot (reset mail to a platform admin's recovery email),
//                      recover_code (one-time recovery code -> new password). All rate-limited per username.
// Signed-in user:      change_password (own; clears must_change_password), recovery_set_password (reset-mail session only)
// Platform admin:      my_security, set_recovery_email, gen_recovery_codes (both need the current password)
// Control room:        list, create (role "platform" = platform admin, platform admins only), set_membership,
//                      remove_membership, set_platform, reset_password, reset_mfa, set_disabled, delete
//   platform admin = every user except himself (own password: change_password); operator admin = viewers and editors
//   whose access is only in operators he administers (never another admin). At least one active platform admin remains.
// MFA: a user with a verified TOTP factor must call with an aal2 session (except recovery_set_password).
// Passwords: only this function can set one (DB trigger on auth.users needs a one-shot permit, allow_pw_change).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "sb_publishable_hCBsqYekz61JY6SFfT_sjw_-wj0QGXT"; // public key
const DOMAIN = "users.yalla-sa.app";
const ORIGINS = ["https://david-transit.github.io"];
const SITE = "https://david-transit.github.io/deadhead-dashboard/"; // where the reset-password mail lands
const CODE_ABC = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ROLES = ["viewer", "editor", "admin"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER = /^[a-z0-9._-]{3,32}$/;

const admin = createClient(SB_URL, SRK, { auth: { persistSession: false, autoRefreshToken: false } });
const emailOf = (u: string) => `${u}@${DOMAIN}`;
const cleanUser = (u: unknown) => String(u ?? "").trim().toLowerCase();
const okPw = (p: unknown) => typeof p === "string" && p.length >= 10 && p.length <= 72;
const cleanName = (n: unknown) => String(n ?? "").trim().slice(0, 80);

const anonClient = () => createClient(SB_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const normCode = (c: unknown) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// recovery codes: HMAC-SHA256 with a server-side pepper (RECOVERY_PEPPER, or derived from the service key, which is never
// stored in the DB), so a copy of the DB alone cannot be brute-forced offline (L6)
let hmacKey: CryptoKey | null = null;
async function codeHash(user: string, code: string) {
  hmacKey ??= await crypto.subtle.importKey("raw", new TextEncoder().encode(Deno.env.get("RECOVERY_PEPPER") || "recovery-pepper:" + SRK),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const h = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`${user}:${normCode(code)}`));
  return "h1$" + [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function newCode() {
  const r = crypto.getRandomValues(new Uint32Array(10));
  const c = [...r].map((x) => CODE_ABC[x % CODE_ABC.length]).join("");
  return c.slice(0, 5) + "-" + c.slice(5);
}
// rate limits per username+IP, per username and per IP (public.auth_attempt); the IP as seen by the platform's proxy
let reqIp = "";
const clientIp = (req: Request) =>
  (req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",").pop() || "").trim().slice(0, 64);
async function attempt(username: string, kind: string) {
  const { data } = await admin.rpc("auth_attempt", { p_username: username, p_kind: kind, p_ip: reqIp || null }).throwOnError();
  if (!data) throw new Fail("rate limit", 429);
}
const logEvent = (user: string | null, username: string | null, event: string, detail: unknown = null) =>
  admin.rpc("auth_event", { p_user: user, p_username: username, p_event: event, p_detail: detail }).then(() => {}, () => {});
async function profileByName(username: string) {
  const { data } = await admin.from("profiles").select("user_id, username, disabled").eq("username", username).maybeSingle();
  return data;
}
async function isPlatformId(id: string) {
  const { data } = await admin.from("platform_admins").select("user_id").eq("user_id", id).maybeSingle();
  return !!data;
}
async function authEmail(id: string) {
  const { data } = await admin.auth.admin.getUserById(id);
  return data?.user?.email || "";
}
// the password of a signed-in user, checked against his real Auth email (internal or recovery address); rate-limited (M6)
async function checkPassword(id: string, username: string, pw: unknown) {
  await attempt(username, "pw_check");
  const c = anonClient();
  const { error } = await c.auth.signInWithPassword({ email: await authEmail(id), password: String(pw ?? "") });
  if (error) throw new Fail("wrong_password", 403);
  await c.auth.signOut({ scope: "local" }).catch(() => {});
}
// claims of a token that admin.auth.getUser() has already accepted (signature checked by GoTrue)
function jwtClaims(t: string): Record<string, unknown> {
  try { return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return {}; }
}
async function setPassword(id: string, pw: string) {
  await admin.rpc("allow_pw_change", { p_user: id }).throwOnError(); // one-shot permit for the auth.users trigger
  const { error } = await admin.auth.admin.updateUserById(id, { password: pw });
  if (error) throw new Fail(/password/i.test(error.message) ? "weak_password" : "server_error", 400);
}
async function verifiedFactors(id: string) {
  const { data } = await admin.auth.admin.mfa.listFactors({ userId: id });
  return (data?.factors || []).filter((f) => f.status === "verified");
}
async function dropFactors(id: string) {
  const { data } = await admin.auth.admin.mfa.listFactors({ userId: id });
  for (const f of data?.factors || []) await admin.auth.admin.mfa.deleteFactor({ userId: id, id: f.id });
  return (data?.factors || []).length;
}
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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
    await admin.rpc("disallow_signup", { p_email: emailOf(username) }); // the permit must not outlive a failure (M4c)
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
  reqIp = clientIp(req);

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

    if (b.action === "sign_in") {
      // accounts with a recovery email sign in through here (their Auth email is the real address); the same answer
      // for every failure, rate-limited per username
      const username = cleanUser(b.username);
      if (!USER.test(username)) throw new Fail("invalid_credentials", 400);
      await attempt(username, "sign_in");
      const p = await profileByName(username);
      const email = p ? await authEmail(p.user_id) : "";
      if (!p || !email || email === emailOf(username)) throw new Fail("invalid_credentials", 400);
      const { data, error } = await anonClient().auth.signInWithPassword({ email, password: String(b.password ?? "") });
      if (error || !data.session) throw new Fail(/ban/i.test(error?.message || "") ? "user_banned" : "invalid_credentials", 400);
      const x = data.session;
      return out({ ok: true, session: { access_token: x.access_token, refresh_token: x.refresh_token, expires_in: x.expires_in, expires_at: x.expires_at, user: x.user } });
    }
    if (b.action === "recovery_options") {
      const username = cleanUser(b.username);
      if (!USER.test(username)) return out({ ok: true, email: false });
      await attempt(username, "options");
      const p = await profileByName(username);
      const has = !!p && !p.disabled && await isPlatformId(p.user_id) && !!(await admin.rpc("recovery_email_get", { p_user: p.user_id })).data;
      return out({ ok: true, email: has });
    }
    if (b.action === "forgot") {
      const username = cleanUser(b.username);
      if (USER.test(username)) {
        await attempt(username, "forgot");
        const p = await profileByName(username);
        if (p && !p.disabled && await isPlatformId(p.user_id)) {
          const { data: em } = await admin.rpc("recovery_email_get", { p_user: p.user_id });
          if (em) {
            const { error } = await anonClient().auth.resetPasswordForEmail(em as string, { redirectTo: SITE });
            await logEvent(p.user_id, username, error ? "forgot_mail_failed" : "forgot_mail_sent", error ? { msg: error.message } : null);
          }
        }
      }
      return out({ ok: true }); // the same answer whether or not a mail went out
    }
    if (b.action === "recover_code") {
      const username = cleanUser(b.username);
      if (!USER.test(username)) throw new Fail("bad_code", 400);
      await attempt(username, "code");
      if (!okPw(b.new_password)) throw new Fail("weak_password");
      const p = await profileByName(username);
      if (!p || p.disabled || !(await isPlatformId(p.user_id))) { await logEvent(null, username, "recovery_code_failed"); throw new Fail("bad_code", 400); }
      const { data: used } = await admin.rpc("recovery_use_code", { p_user: p.user_id, p_hash: await codeHash(p.user_id, b.code as string) }).throwOnError();
      if (!used) { await logEvent(p.user_id, username, "recovery_code_failed"); throw new Fail("bad_code", 400); }
      await setPassword(p.user_id, b.new_password as string);
      await admin.from("profiles").update({ must_change_password: false }).eq("user_id", p.user_id).throwOnError();
      // a recovery code is the backup second factor: it also removes the lost authenticator; a new one is enrolled at sign-in
      const dropped = await dropFactors(p.user_id);
      const { data: left } = await admin.rpc("recovery_codes_left", { p_user: p.user_id });
      await logEvent(p.user_id, username, "recovery_code_used", { left, mfa_removed: dropped });
      return out({ ok: true, left });
    }

    // ---------- who is calling ----------
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) throw new Fail("not_signed_in", 401);
    const { data: me, error: meErr } = await admin.auth.getUser(token);
    if (meErr || !me?.user) throw new Fail("not_signed_in", 401);
    const uid = me.user.id;
    const { data: myProf } = await admin.from("profiles").select("username, must_change_password, disabled").eq("user_id", uid).maybeSingle();
    if (myProf?.disabled) throw new Fail("disabled", 403);
    const claims = jwtClaims(token);
    const needMfa = async () => { // M3: once a user has a verified factor, a password-only session is not enough
      if (claims.aal !== "aal2" && (await verifiedFactors(uid)).length) throw new Fail("mfa_required", 403);
    };

    if (b.action === "change_password") {
      if (!myProf) throw new Fail("not_allowed", 403);
      await needMfa();
      if (!okPw(b.new_password)) throw new Fail("weak_password");
      if (b.new_password === b.current_password) throw new Fail("same_password");
      await checkPassword(uid, myProf.username, b.current_password); // a separate check session, not the caller's
      await setPassword(uid, b.new_password as string);
      await admin.from("profiles").update({ must_change_password: false }).eq("user_id", uid).throwOnError();
      await logEvent(uid, myProf.username, "password_changed");
      return out({ ok: true });
    }
    if (b.action === "recovery_set_password") {
      // after the reset-password mail: only a session that the mail link itself opened (amr "recovery"/"otp", at most
      // 10 minutes old) may set a new password here, and only for an account that has a recovery email. The password
      // is set server-side, so must_change_password is cleared only when the password really changed. (H2)
      if (!myProf) throw new Fail("not_allowed", 403);
      const amr = (claims.amr || []) as { method?: string; timestamp?: number }[];
      const now = Date.now() / 1000;
      if (!amr.some((a) => ["recovery", "otp"].includes(String(a.method)) && now - Number(a.timestamp || 0) < 600)) throw new Fail("not_recovery", 403);
      const { data: em } = await admin.rpc("recovery_email_get", { p_user: uid });
      if (!em) throw new Fail("not_recovery", 403);
      if (!okPw(b.new_password)) throw new Fail("weak_password");
      await setPassword(uid, b.new_password as string);
      await admin.from("profiles").update({ must_change_password: false }).eq("user_id", uid).throwOnError();
      await logEvent(uid, myProf.username, "recovered_by_mail");
      return out({ ok: true, username: myProf.username });
    }

    // ---------- platform admin: own recovery settings ----------
    if (["my_security", "set_recovery_email", "gen_recovery_codes"].includes(String(b.action))) {
      if (!myProf || myProf.must_change_password || !(await isPlatformId(uid))) throw new Fail("not_allowed", 403);
      await needMfa();
      if (b.action === "my_security") {
        const [{ data: em }, { data: left }] = await Promise.all([admin.rpc("recovery_email_get", { p_user: uid }), admin.rpc("recovery_codes_left", { p_user: uid })]);
        return out({ ok: true, recovery_email: em || null, codes_left: left || 0 });
      }
      await checkPassword(uid, myProf.username, b.current_password);
      if (b.action === "set_recovery_email") {
        const em = b.email == null || b.email === "" ? null : String(b.email).trim().toLowerCase();
        if (em !== null && (!EMAIL.test(em) || em.length > 254 || em.endsWith("@" + DOMAIN))) throw new Fail("bad_email");
        const { error } = await admin.auth.admin.updateUserById(uid, { email: em || emailOf(myProf.username), email_confirm: true });
        if (error) throw new Fail(/already|exists|registered/i.test(error.message) ? "email_taken" : "server_error", 400);
        await admin.rpc("recovery_email_set", { p_user: uid, p_email: em }).throwOnError();
        await logEvent(uid, myProf.username, em ? "recovery_email_set" : "recovery_email_removed");
        return out({ ok: true });
      }
      const codes = Array.from({ length: 8 }, newCode);
      await admin.rpc("recovery_set_codes", { p_user: uid, p_hashes: await Promise.all(codes.map((c) => codeHash(uid, c))) }).throwOnError();
      await logEvent(uid, myProf.username, "recovery_codes_generated");
      return out({ ok: true, codes });
    }

    // ---------- control room ----------
    if (!myProf || myProf.must_change_password) throw new Fail("not_allowed", 403);
    await needMfa();
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
      if (!UUID.test(target) || target === uid) return false;
      if (isPlatform) return true;
      if (platformIds.has(target)) return false;
      const ms = await membershipsOf(target);
      // an operator admin manages viewers and editors only: another admin is managed by a platform admin (L2)
      return ms.length > 0 && ms.every((m) => adminOps.has(m.operator_id) && m.role !== "admin");
    };
    const needTarget = async () => {
      const t = String(b.user_id || "");
      if (!(await manageable(t))) throw new Fail("not_allowed", 403);
      const { data } = await admin.from("profiles").select("user_id").eq("user_id", t).maybeSingle();
      if (!data) throw new Fail("bad_input");
      return t;
    };
    // at least one active platform admin must remain when "target" stops being one (revoke, disable, delete)
    const keepOnePlatform = async (target: string) => {
      if (!platformIds.has(target)) return;
      const { data: act } = await admin.from("profiles").select("user_id").in("user_id", [...platformIds]).eq("disabled", false);
      if (!(act || []).some((x) => x.user_id !== target)) throw new Fail("last_platform_admin", 409);
    };
    const needOpRole = () => {
      const op = String(b.operator_id || ""), role = String(b.role || "");
      if (!UUID.test(op) || !ROLES.includes(role)) throw new Fail("bad_input");
      if (!canOp(op) || (role === "admin" && !isPlatform)) throw new Fail("not_allowed", 403);
      return { op, role };
    };

    switch (b.action) {
      case "list": {
        const { data: profs } = await admin.from("profiles").select("user_id, username, display_name, must_change_password, disabled, created_at");
        const { data: ms } = await admin.from("memberships").select("user_id, operator_id, role");
        const seen = new Map<string, string>(), mfa = new Set<string>();
        for (let page = 1; page < 20; page++) {
          const { data } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
          for (const u of data?.users || []) {
            seen.set(u.id, u.last_sign_in_at || "");
            if ((u.factors || []).some((f) => f.status === "verified")) mfa.add(u.id);
          }
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
            me: p.user_id === uid, manageable: await manageable(p.user_id), mfa: mfa.has(p.user_id),
          });
        }
        users.sort((x, y) => x.username.localeCompare(y.username));
        return out({ ok: true, users, platform: isPlatform });
      }

      case "create": {
        const username = cleanUser(b.username);
        if (!USER.test(username)) throw new Fail("bad_username");
        if (!okPw(b.password)) throw new Fail("weak_password");
        if (b.role === "platform") { // platform admin: no operator needed; only a platform admin may create one
          if (!isPlatform) throw new Fail("not_allowed", 403);
          const id = await createAccount(username, b.password as string, cleanName(b.display_name), true, uid);
          await admin.from("platform_admins").insert({ user_id: id }).throwOnError();
          await logEvent(uid, myProf.username, "platform_admin_created", { user: username });
          return out({ ok: true, user_id: id });
        }
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

      case "set_platform": {
        if (!isPlatform) throw new Fail("not_allowed", 403);
        const t = await needTarget(), on = !!b.on;
        if (on) await admin.from("platform_admins").upsert({ user_id: t }, { onConflict: "user_id" }).throwOnError();
        else { await keepOnePlatform(t); await admin.from("platform_admins").delete().eq("user_id", t).throwOnError(); }
        await logEvent(uid, myProf.username, on ? "platform_admin_granted" : "platform_admin_revoked", { user: t });
        return out({ ok: true });
      }

      case "reset_password": {
        const t = await needTarget();
        if (!okPw(b.password)) throw new Fail("weak_password");
        await setPassword(t, b.password as string);
        await admin.from("profiles").update({ must_change_password: true }).eq("user_id", t).throwOnError();
        await logEvent(uid, myProf.username, "password_reset_by_admin", { user: t });
        return out({ ok: true });
      }

      case "reset_mfa": { // lost phone: remove the user's authenticator; a new one is enrolled at the next sign-in
        const t = await needTarget();
        const n = await dropFactors(t);
        await logEvent(uid, myProf.username, "mfa_reset_by_admin", { user: t, factors: n });
        return out({ ok: true, removed: n });
      }

      case "set_disabled": {
        const t = await needTarget(), off = !!b.disabled;
        if (off) await keepOnePlatform(t);
        // the profile first: its DB trigger refuses (at commit, serialised) to leave no active platform admin (L4)
        await admin.from("profiles").update({ disabled: off }).eq("user_id", t).throwOnError();
        const { error } = await admin.auth.admin.updateUserById(t, { ban_duration: off ? "876000h" : "none" });
        if (error) { await admin.from("profiles").update({ disabled: !off }).eq("user_id", t); throw error; }
        return out({ ok: true });
      }

      case "delete": {
        const t = await needTarget();
        await keepOnePlatform(t);
        const { error } = await admin.auth.admin.deleteUser(t);
        if (error) throw error;
        return out({ ok: true });
      }

      default:
        throw new Fail("bad_input");
    }
  } catch (e) {
    if (e instanceof Fail) return out({ error: e.code }, e.status);
    if (/last_platform_admin/.test(String((e as Error)?.message || ""))) return out({ error: "last_platform_admin" }, 409);
    console.error("manage_users", b.action, e);
    return out({ error: "server_error" }, 500);
  }
});
