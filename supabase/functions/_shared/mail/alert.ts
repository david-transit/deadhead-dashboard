// Alert to David on the channel chosen in support_settings (WhatsApp PRD R3, PRD-email M9, M10), from the mail functions.
// whatsapp -> wa_send template alert_v1 (server call, x-internal-key); email -> sendMail; off -> nothing.
// Text carries no contact name and no content (M9, WhatsApp PRD R3א).
// makeAlerter is pure (tested in Node); alerter wires it to Supabase, Resend and wa_send (Edge Functions only).
// deno-lint-ignore-file no-explicit-any
import { sendMail } from "./send.ts";
import { supabaseMailDb } from "./db.ts";
import { brandFor } from "./http.ts";

export const ALERT_SUBJECT = "יאללה־סע: התראה";
export const INBOX_LINK = "לכלי הפניות: https://yalla-sa.app/support/";

interface AlertSettings { alert_channel: string; alert_to?: string | null; alert_email?: string | null; mail_daily_cap?: number }
export interface AlerterDeps {
  settings(): Promise<AlertSettings | null>;
  mail(to: string, subject: string, body: string, warn: boolean): Promise<unknown>;
  wa(to: string, text: string): Promise<unknown>;
}

export function makeAlerter(d: AlerterDeps, warn = true) {
  return async (text: string): Promise<unknown> => {
    const s = await d.settings();
    if (!s || s.alert_channel === "off") return { ok: false, error: "alert_channel_off" };
    if (s.alert_channel === "email") {
      if (!s.alert_email) return { ok: false, error: "alert_channel_email" };
      return d.mail(s.alert_email, ALERT_SUBJECT, `${text}\n\n${INBOX_LINK}`, warn);
    }
    if (!s.alert_to) return { ok: false, error: "alert_channel_whatsapp" };
    return d.wa(s.alert_to, text);
  };
}

// warn=false: an alert mail that itself crosses 80% raises no further warning (no recursion)
export function alerter(admin: any, supabaseUrl: string, warn = true): (text: string) => Promise<unknown> {
  const settings = async () => (await admin.from("support_settings")
    .select("alert_channel, alert_to, alert_email, mail_daily_cap").eq("id", 1).single()).data;
  return makeAlerter({
    settings,
    async mail(to, subject, body, w) {
      const apiKey = Deno.env.get("RESEND_API_KEY");
      if (!apiKey) return { ok: false, error: "not_configured" };
      const s = await settings();
      return sendMail({ db: supabaseMailDb(admin), fetch, apiKey, brand: brandFor(supabaseUrl), cap: s?.mail_daily_cap ?? 100,
        alert: w ? alerter(admin, supabaseUrl, false) : undefined }, { kind: "alert", to, subject, body });
    },
    async wa(to, text) {
      const r = await fetch(`${supabaseUrl}/functions/v1/wa_send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-key": Deno.env.get("WA_INTERNAL_KEY") || "" },
        body: JSON.stringify({ action: "template", to, template: "alert_v1", params: [text] }),
      });
      return r.json().catch(() => ({ ok: false, error: `wa_send_${r.status}` }));
    },
  }, warn);
}
