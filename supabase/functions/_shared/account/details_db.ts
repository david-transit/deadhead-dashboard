// Supabase adapter for sendDetails (welcome-mail spec §5, §6.3). Edge Functions only (uses the service-role client).
// deno-lint-ignore-file no-explicit-any
import type { DetailsDeps, Snap } from "./details.ts";
import { newTempPw } from "./welcome.ts";
import { sendAccountMail } from "../mail/send.ts";
import { WARN80_TEXT } from "../mail/send.ts";
import type { Brand } from "../mail/template.ts";

const one = async (q: any) => { const { data, error } = await q; if (error) throw error; return data; };

export function supabaseDetailsDeps(admin: any, o: {
  byUser: string; byName: string; fetch: typeof fetch; apiKey: string; brand: Brand; cap: number;
  alert: (text: string) => Promise<unknown>; setPassword: (id: string, pw: string) => Promise<void>; anon: () => any;
}): DetailsDeps {
  return {
    async target(id) {
      const p = await one(admin.from("profiles").select("username, display_name, disabled").eq("user_id", id).single());
      const email = await one(admin.rpc("contact_email_get", { p_user: id }));
      const { data } = await admin.auth.admin.getUserById(id);
      return { username: p.username, name: p.display_name, disabled: !!p.disabled, email: email || null, authEmail: data?.user?.email || "" };
    },
    lock: async (id) => !!(await one(admin.rpc("details_lock", { p_user: id }))),
    unlock: async (id) => { await one(admin.rpc("details_unlock", { p_user: id })); },
    sentToday: async () => Number(await one(admin.rpc("support_mail_sent_today"))) || 0,
    cap: o.cap,
    async snapshot(id) {
      const rows = await one(admin.rpc("pw_snapshot", { p_user: id }));
      const r = (Array.isArray(rows) ? rows[0] : rows) || {};
      if (!r.hash) throw new Error("no_snapshot");
      return { hash: r.hash, must: !!r.must, exp: r.exp ?? null } as Snap;
    },
    restore: async (id, s) => { await one(admin.rpc("pw_restore", { p_user: id, p_hash: s.hash, p_must: s.must, p_exp: s.exp })); },
    async setTemp(id, pw, expiresAt) {
      await o.setPassword(id, pw);
      await one(admin.from("profiles").update({ must_change_password: true, temp_password_expires_at: expiresAt.toISOString() }).eq("user_id", id));
    },
    async trySignIn(authEmail, pw) {
      if (!authEmail) return false;
      const c = o.anon();
      const { data, error } = await c.auth.signInWithPassword({ email: authEmail, password: pw });
      if (error || !data?.session) return false;
      await c.auth.signOut({ scope: "local" }).catch(() => {});
      return true;
    },
    send: (m) => sendAccountMail({ fetch: o.fetch, apiKey: o.apiKey, brand: o.brand }, m),
    log: async (id, status, error) => { await one(admin.rpc("account_mail_log_add", { p_user: id, p_by: o.byUser, p_status: status, p_error: error ?? null })); },
    event: async (name, detail) => { await admin.rpc("auth_event", { p_user: o.byUser, p_username: o.byName, p_event: name, p_detail: detail }).then(() => {}, () => {}); },
    warn80: async () => { await o.alert(WARN80_TEXT).catch(() => {}); },
    now: () => new Date(),
    pw: () => newTempPw(),
  };
}
