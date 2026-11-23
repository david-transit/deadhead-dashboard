// Web Push on Supabase (service role) for the alerters (PRD-email M20). Keys: secrets VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.
// Edge Functions only (Deno.env); the logic is in push.ts.
// deno-lint-ignore-file no-explicit-any
import { pushToAgents, type PushStore } from "./push.ts";

export function supabasePushStore(admin: any): PushStore {
  return {
    async list() {
      const { data, error } = await admin.from("support_push_subs").select("id, endpoint, p256dh, auth");
      if (error) throw error;
      return data ?? [];
    },
    async remove(ids) { const { error } = await admin.from("support_push_subs").delete().in("id", ids); if (error) throw error; },
  };
}

export const vapidKeys = () => ({ publicKey: Deno.env.get("VAPID_PUBLIC_KEY") || "", privateKey: Deno.env.get("VAPID_PRIVATE_KEY") || "" });

export function pushAlert(admin: any): (text: string) => Promise<{ ok: boolean; error?: string }> {
  return async (text) => {
    try {
      // one log line per alert (no text: M9), so a missed alert can be traced
      const r = await pushToAgents(supabasePushStore(admin), text, vapidKeys());
      console.log("push alert", JSON.stringify(r));
      return r;
    }
    catch (e) { console.error("push alert", String(e).slice(0, 200)); return { ok: false, error: "push_failed" }; }
  };
}
