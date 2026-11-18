// SupportDb on Supabase (service role; RLS is bypassed here, so every caller is checked in the function first).
// Tables: migration <ts>_support_whatsapp.sql (spec §2).
// deno-lint-ignore-file no-explicit-any
import type { SupportDb, SupportSettings, Contact, NewMessage } from "./send.ts";

export function supabaseDb(admin: any): SupportDb & {
  contactId(waId: string, name?: string): Promise<string>;
} {
  async function contactId(waId: string, name?: string): Promise<string> {
    const { data } = await admin.from("support_contacts").select("id").eq("wa_id", waId).maybeSingle();
    if (data) return data.id;
    const { data: ins, error } = await admin.from("support_contacts")
      .upsert({ wa_id: waId, wa_name: name ?? null }, { onConflict: "wa_id" }).select("id").single();
    if (error) throw error;
    return ins.id;
  }
  return {
    contactId,
    async settings(): Promise<SupportSettings> {
      const { data, error } = await admin.from("support_settings").select("*").eq("id", 1).single();
      if (error) throw error;
      return data as SupportSettings;
    },
    async contactByPhone(waId: string): Promise<Contact | null> {
      const [{ data: c }, { data: p }] = await Promise.all([
        admin.from("support_contacts").select("id, consent_at, opted_out_at").eq("wa_id", waId).maybeSingle(),
        admin.from("profiles").select("user_id").eq("phone", waId).not("wa_consent_at", "is", null).limit(1),
      ]);
      if (!c && !p?.length) return null;
      return { id: c?.id ?? "", consent: !!c?.consent_at || !!p?.length, optedOut: !!c?.opted_out_at };
    },
    async lastInboundAt(waId: string): Promise<Date | null> {
      const { data } = await admin.from("support_conversations").select("last_inbound_at, support_contacts!inner(wa_id)")
        .eq("support_contacts.wa_id", waId).not("last_inbound_at", "is", null)
        .order("last_inbound_at", { ascending: false }).limit(1);
      return data?.[0]?.last_inbound_at ? new Date(data[0].last_inbound_at) : null;
    },
    async monthSpend(): Promise<number> {
      const { data, error } = await admin.rpc("support_month_spend");
      if (error) throw error;
      return Number(data ?? 0);
    },
    async insertMessage(m: NewMessage): Promise<string> {
      const contact_id = await contactId(m.to);
      const { data, error } = await admin.from("support_messages").insert({
        contact_id, conversation_id: m.conversation_id, direction: "out", sender: m.sender, agent_id: m.agent_id,
        body: m.body, template: m.template, status: m.status,
      }).select("id").single();
      if (error) throw error;
      return data.id;
    },
    async updateMessage(id, patch) {
      const { error } = await admin.from("support_messages").update(patch).eq("id", id);
      if (error) throw error;
    },
    async markAlertSent(level) {
      const { data, error } = await admin.rpc("support_mark_alert", { p_level: level });
      if (error) throw error;
      return !!data;
    },
  };
}
