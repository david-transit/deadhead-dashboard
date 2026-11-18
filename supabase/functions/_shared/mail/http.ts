// Small helpers shared by the mail Edge Functions (no Deno APIs here, so Node tests can import it).
import type { Brand } from "./template.ts";

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export class Fail extends Error {
  code: string; status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}

// payload of a JWT, read only after admin.auth.getUser accepted the token
export function claimsOf(t: string): Record<string, unknown> {
  try { return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return {}; }
}
// constant-time compare of shared secrets
export function safeEq(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}
export const brandFor = (supabaseUrl: string): Brand =>
  ({ logoUrl: `${supabaseUrl}/storage/v1/object/public/brand/email-logo.png`, siteUrl: "https://yalla-sa.app" });
