// Actions of the Edge Function support_push (design 2026-11-22-email-push-alerts-design.md §5). Pure: storage and sending
// come in through deps, so it is tested in Node. The caller is a signed-in user; only support agents may register devices.
import { isPushEndpoint } from "./push.ts";

export const TEST_TEXT = "בדיקה: התראות פועלות במכשיר הזה";

export interface PushApiDeps {
  isAgent(uid: string): Promise<boolean>;
  upsert(r: { user_id: string; endpoint: string; p256dh: string; auth: string; label: string | null }): Promise<void>;
  remove(uid: string, endpoint: string): Promise<void>;
  sendOwn(uid: string, text: string): Promise<{ ok: boolean; sent?: number; error?: string }>;
  publicKey(): string; // VAPID public key (public by nature): the page subscribes with it, so it needs no redeploy
}
type Out = { ok: boolean; error?: string; status?: number; sent?: number; key?: string };
const bad: Out = { ok: false, error: "bad_input", status: 400 };
const key = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 120 && /^[A-Za-z0-9_\-=]+$/.test(v);

// deno-lint-ignore no-explicit-any
export async function pushAction(d: PushApiDeps, uid: string, b: any): Promise<Out> {
  if (!(await d.isAgent(uid))) return { ok: false, error: "not_allowed", status: 403 };
  if (b?.action === "key") {
    const k = d.publicKey();
    return k ? { ok: true, key: k } : { ok: false, error: "push_not_configured", status: 503 };
  }
  if (b?.action === "subscribe") {
    const ep = String(b.endpoint || "");
    if (ep.length > 1000 || !isPushEndpoint(ep) || !key(b.keys?.p256dh) || !key(b.keys?.auth)) return bad;
    const label = typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 40) : null;
    await d.upsert({ user_id: uid, endpoint: ep, p256dh: b.keys.p256dh, auth: b.keys.auth, label });
    return { ok: true };
  }
  if (b?.action === "unsubscribe") {
    const ep = String(b.endpoint || "");
    if (!ep || ep.length > 1000) return bad;
    await d.remove(uid, ep);
    return { ok: true };
  }
  if (b?.action === "test") {
    const r = await d.sendOwn(uid, TEST_TEXT);
    return r.ok ? { ok: true, sent: r.sent } : { ok: false, error: r.error || "push_failed", status: 422 };
  }
  return bad;
}
