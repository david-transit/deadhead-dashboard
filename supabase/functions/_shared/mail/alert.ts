// Alert to David on the channel chosen in support_settings (WhatsApp PRD R3, PRD-email M9), from the mail functions.
// whatsapp -> wa_send template alert_v1 (server call, x-internal-key); email -> sendMail; off -> nothing.
// Text carries no contact name and no content (M9, WhatsApp PRD R3א). Uses Deno env: Edge Functions only.
// deno-lint-ignore-file no-explicit-any
import { sendMail } from "./send.ts";
import { supabaseMailDb } from "./db.ts";
import { brandFor } from "./http.ts";

export const ALERT_SUBJECT = "יאללה־סע: התראה";
export const INBOX_LINK = "לכלי הפניות: https://yalla-sa.app/support/";

export function alerter(admin: any, supabaseUrl: string) {
  return async (text: string): Promise<unknown> => {
    const { data: s } = await admin.from("support_settings")
      .select("alert_channel, alert_to, alert_email, mail_daily_cap").eq("id", 1).single();
    if (!s || s.alert_channel === "off") return { ok: false, error: "alert_channel_off" };
    if (s.alert_channel === "email") {
      const apiKey = Deno.env.get("RESEND_API_KEY");
      if (!s.alert_email || !apiKey) return { ok: false, error: "alert_channel_email" };
      return sendMail({ db: supabaseMailDb(admin), fetch, apiKey, brand: brandFor(supabaseUrl), cap: s.mail_daily_cap ?? 100 },
        { kind: "alert", to: s.alert_email, subject: ALERT_SUBJECT, body: `${text}\n\n${INBOX_LINK}` });
    }
    if (!s.alert_to) return { ok: false, error: "alert_channel_whatsapp" };
    const r = await fetch(`${supabaseUrl}/functions/v1/wa_send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": Deno.env.get("WA_INTERNAL_KEY") || "" },
      body: JSON.stringify({ action: "template", to: s.alert_to, template: "alert_v1", params: [text] }),
    });
    return r.json().catch(() => ({ ok: false, error: `wa_send_${r.status}` }));
  };
}
