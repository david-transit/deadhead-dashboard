// Inbound mail: turn PostalMime's output into what we store, and decide whether to store it at all.
// Email spec §3 "קליטה" step 2; PRD-email M6, M7, M16. Pure: the Edge Function does PostalMime.parse, tests pass objects.
export interface Parsed { from: { address: string; name?: string }; to?: { address: string }[]; subject?: string;
  messageId?: string; inReplyTo?: string; references?: string; date?: string; text?: string; html?: string;
  headers: { key: string; value: string }[];
  attachments: { filename?: string | null; mimeType: string; content: ArrayBuffer | Uint8Array | string }[] }
export type Verdict = "ok" | "spoofed" | "auto" | "bounce" | "own_domain";
export interface Mail { verdict: Verdict; email: string; name: string | null; subject: string | null; text: string;
  messageId: string; refs: string[]; files: { name: string; type: string; bytes: Uint8Array }[]; filesDropped: number }

export const OWN_DOMAIN = "yalla-sa.app";
export const MAX_FILES_BYTES = 10 * 1024 * 1024;
const CF_AUTHSERV = "mx.cloudflare.net";

const ids = (s?: string) => (s ?? "").match(/<[^<>\s]+>/g) ?? [];
const header = (p: Parsed, k: string) => p.headers.filter((h) => h.key.toLowerCase() === k).map((h) => h.value);

// Cloudflare Email Routing's own verdict; null when no Cloudflare header (then we cannot judge and let it through)
function authResults(p: Parsed): { spf: string; dkim: string[]; dmarc: string } | null {
  // topmost wins: Cloudflare prepends its own; anything below it came with the mail and may be forged
  const v = p.headers.filter((h) => ["authentication-results", "arc-authentication-results"].includes(h.key.toLowerCase()))
    .map((h) => h.value).find((x) => x.replace(/^\s*(i=\d+;\s*)?/, "").toLowerCase().startsWith(CF_AUTHSERV));
  if (!v) return null;
  const all = (k: string) => [...v.toLowerCase().matchAll(new RegExp(`\\b${k}=(\\w+)`, "g"))].map((m) => m[1]);
  return { spf: all("spf")[0] ?? "none", dkim: all("dkim"), dmarc: all("dmarc")[0] ?? "none" };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const safeName = (n: string | null | undefined, i: number) =>
  (n ?? "").replace(/[\/\\\u0000-\u001f]/g, "").replace(/^\.+/, "").trim().slice(0, 120) || `file-${i + 1}`;
const toBytes = (c: ArrayBuffer | Uint8Array | string) =>
  typeof c === "string" ? new TextEncoder().encode(c) : c instanceof Uint8Array ? c : new Uint8Array(c);

function verdictOf(p: Parsed, email: string): Verdict {
  const ar = authResults(p);
  if (ar && (ar.dmarc === "fail" || (ar.spf !== "pass" && !ar.dkim.includes("pass")))) return "spoofed";
  const local = email.split("@")[0];
  const rp = header(p, "return-path")[0];
  if (local === "mailer-daemon" || local === "postmaster" || (rp !== undefined && rp.trim() === "<>")) return "bounce";
  if (email.endsWith("@" + OWN_DOMAIN)) return "own_domain";
  const as = header(p, "auto-submitted")[0];
  const prec = (header(p, "precedence")[0] ?? "").trim().toLowerCase();
  if ((as && as.trim().toLowerCase() !== "no") || ["bulk", "junk", "list", "auto_reply"].includes(prec)
    || header(p, "x-autoreply").length || header(p, "x-autorespond").length || header(p, "list-id").length) return "auto";
  return "ok";
}

export function classify(p: Parsed): Mail {
  const email = (p.from?.address ?? "").trim().toLowerCase();
  const all = p.attachments.map((a, i) => ({ name: safeName(a.filename, i), type: a.mimeType || "application/octet-stream", bytes: toBytes(a.content) }));
  const total = all.reduce((s, f) => s + f.bytes.byteLength, 0);
  const tooBig = total > MAX_FILES_BYTES;
  return {
    verdict: verdictOf(p, email),
    email,
    name: p.from?.name?.trim() || null,
    subject: p.subject?.trim() || null,
    text: (p.text ?? (p.html ? htmlToText(p.html) : "")).trim(),
    messageId: ids(p.messageId)[0] ?? `<gen-${crypto.randomUUID()}@${OWN_DOMAIN}>`,
    refs: [...new Set([...ids(p.inReplyTo), ...ids(p.references)])],
    files: tooBig ? [] : all,
    filesDropped: tooBig ? all.length : 0,
  };
}
