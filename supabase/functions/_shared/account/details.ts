// "Send details" (welcome-mail spec §6.3): new temporary password, checked by a real sign-in, mailed to the user's
// contact address. If anything after the password change fails, the old password (hash + flags) is put back.
// Pure orchestration over DetailsDeps; the Supabase adapter is details_db.ts.
import { quotaDecision } from "../mail/quota.ts";
import { welcomeBody, WELCOME_SUBJECT, TEMP_DAYS } from "./welcome.ts";

export interface Snap { hash: string; must: boolean; exp: string | null }
export interface Target { username: string; name: string | null; disabled: boolean; email: string | null; authEmail: string }
export interface DetailsDeps {
  target(id: string): Promise<Target>;
  lock(id: string): Promise<boolean>; unlock(id: string): Promise<void>;
  sentToday(): Promise<number>; cap: number;
  snapshot(id: string): Promise<Snap>; restore(id: string, s: Snap): Promise<void>;
  setTemp(id: string, pw: string, expiresAt: Date): Promise<void>; // setPassword + must_change=true + expiry
  trySignIn(authEmail: string, pw: string): Promise<boolean>;
  send(m: { to: string; subject: string; body: string; key: string }): Promise<{ ok: boolean; error?: string }>;
  log(id: string, status: "sent" | "failed", error?: string): Promise<void>;
  event(name: string, detail: Record<string, unknown>): Promise<void>;
  warn80(): Promise<void>; now(): Date; pw(): string;
}
export type DetailsOut = { ok: true; expires_at: string } |
  { ok: false; error: "disabled" | "no_email" | "busy" | "quota" | "send_failed" | "send_failed_locked" };

export async function sendDetails(d: DetailsDeps, userId: string): Promise<DetailsOut> {
  if (!(await d.lock(userId))) return { ok: false, error: "busy" };
  try {
    const t = await d.target(userId);
    if (t.disabled) return { ok: false, error: "disabled" };
    if (!t.email) return { ok: false, error: "no_email" };
    const q = quotaDecision("account", await d.sentToday(), d.cap);
    if (!q.send) return { ok: false, error: "quota" };

    const snap = await d.snapshot(userId);
    const pw = d.pw(), expiresAt = new Date(d.now().getTime() + TEMP_DAYS * 864e5);
    let why = "";
    try {
      await d.setTemp(userId, pw, expiresAt);
      if (!(await d.trySignIn(t.authEmail, pw))) why = "sign_in_check";
      else {
        const r = await d.send({ to: t.email, subject: WELCOME_SUBJECT, key: crypto.randomUUID(),
          body: welcomeBody({ name: t.name, username: t.username, password: pw, expiresAt }) });
        if (!r.ok) why = r.error || "send_failed";
      }
    } catch (e) { why = "set_temp: " + String((e as Error)?.message || e).slice(0, 100); }

    // record-keeping never changes the outcome: the old password is put back first, and a sent mail stays "sent"
    const quiet = async (f: () => Promise<unknown>) => { try { await f(); } catch { /* logged best-effort */ } };
    if (why) {
      let restored = true;
      try { await d.restore(userId, snap); } catch { restored = false; }
      await quiet(() => d.log(userId, "failed", why));
      await quiet(() => d.event(restored ? "details_mail_failed" : "details_restore_failed", { user: userId, why }));
      return { ok: false, error: restored ? "send_failed" : "send_failed_locked" };
    }
    await quiet(() => d.log(userId, "sent"));
    await quiet(() => d.event("details_mail_sent", { user: userId }));
    if (q.warn80) await quiet(() => d.warn80());
    return { ok: true, expires_at: expiresAt.toISOString() };
  } finally {
    try { await d.unlock(userId); } catch { /* the 60-second lease expires on its own */ }
  }
}
