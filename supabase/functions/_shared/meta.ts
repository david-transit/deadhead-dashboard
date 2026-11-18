// WhatsApp Cloud API (Meta Graph) client and webhook parsing (yalla-sa support, spec §1, §6).
// Uses only fetch + Web Crypto, so it runs in Deno (Edge Functions) and in node --test.

const GRAPH = "https://graph.facebook.com/v23.0";
const DELAYS = [500, 1000, 2000]; // wait before retries 2 and 3 (the third value is spare)

export interface SendResult { ok: boolean; wamid?: string; error?: string; retryable?: boolean }
export interface InMsg { wamid: string; from: string; name: string; text: string; ts: Date }
export interface StatusEv { wamid: string; status: string; billable: boolean; category: string; error?: string }

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

// Meta signs each webhook body: X-Hub-Signature-256: sha256=<HMAC-SHA256(app secret, raw body)>
export async function verifySignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header || !appSecret || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const got = header.slice(7).toLowerCase();
  if (got.length !== want.length) return false;
  let diff = 0; // constant-time compare
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

export async function graphSend(payload: object, cfg: { token: string; phoneId: string },
  fetchFn: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<SendResult> {
  let last: SendResult = { ok: false, error: "not sent", retryable: true };
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(DELAYS[i - 1]);
    try {
      const res = await fetchFn(`${GRAPH}/${cfg.phoneId}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.messages?.[0]?.id) return { ok: true, wamid: j.messages[0].id };
      last = { ok: false, error: j?.error?.message || `HTTP ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
      if (!last.retryable) return last;
    } catch (e) {
      last = { ok: false, error: String((e as Error)?.message || e), retryable: true }; // network error / timeout
    }
  }
  return last;
}

export function textPayload(to: string, body: string): object {
  return { messaging_product: "whatsapp", to, type: "text", text: { body } };
}

export function templatePayload(to: string, name: string, params: string[], quickReply?: string): object {
  const components: object[] = [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }];
  if (quickReply) components.push({ type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: quickReply }] });
  return { messaging_product: "whatsapp", to, type: "template", template: { name, language: { code: "he" }, components } };
}

// deno-lint-ignore no-explicit-any
export function parseWebhook(json: any): { messages: InMsg[]; statuses: StatusEv[] } {
  const out = { messages: [] as InMsg[], statuses: [] as StatusEv[] };
  for (const e of json?.entry ?? []) for (const c of e?.changes ?? []) {
    if (c?.field !== "messages") continue;
    const v = c.value ?? {};
    const names = new Map<string, string>((v.contacts ?? []).map((k: any) => [k.wa_id, k.profile?.name ?? ""]));
    for (const m of v.messages ?? []) {
      const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "";
      out.messages.push({ wamid: m.id, from: m.from, name: names.get(m.from) ?? "", text, ts: new Date(Number(m.timestamp) * 1000) });
    }
    for (const s of v.statuses ?? []) {
      const ev: StatusEv = { wamid: s.id, status: s.status, billable: !!s.pricing?.billable, category: s.pricing?.category ?? "" };
      if (s.errors?.length) ev.error = s.errors[0].title || s.errors[0].message || "error";
      out.statuses.push(ev);
    }
  }
  return out;
}
