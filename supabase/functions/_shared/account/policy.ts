// User-management rules (welcome-mail spec §6.1, §6.4; David 2026-11-19): only a platform admin changes users; an
// operator admin only views. Temporary passwords expire after TEMP_DAYS. Pure: no I/O.
import { TEMP_DAYS } from "./welcome.ts";
import { ROLES, TOOL_MODULES } from "../access.ts";

export const PLATFORM_ONLY: readonly string[] = ["create", "set_membership", "remove_membership", "set_tool_role", "remove_tool_role", "set_platform", "reset_password",
  "reset_mfa", "set_disabled", "delete", "get_contact_email", "set_contact_email", "send_details", "move_operator"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// move_operator: both operator ids are uuids and differ
export const moveInputOk = (from: unknown, to: unknown): boolean =>
  typeof from === "string" && typeof to === "string" && UUID.test(from) && UUID.test(to) && from.toLowerCase() !== to.toLowerCase();

export function writeAllowed(action: string, isPlatform: boolean, self: boolean): boolean {
  if (action === "set_name") return self || isPlatform;
  if (PLATFORM_ONLY.includes(action)) return isPlatform;
  return true; // list (and unknown actions, which the switch rejects as bad_input)
}

export const tempExpiry = (now: Date) => new Date(now.getTime() + TEMP_DAYS * 864e5);

// a temporary password with no expiry date (set before this feature) never expires
export function tempExpired(p: { must_change_password: boolean; temp_password_expires_at: string | null }, now: Date): boolean {
  return !!p.must_change_password && !!p.temp_password_expires_at && new Date(p.temp_password_expires_at).getTime() < now.getTime();
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export function cleanContactEmail(x: unknown): string | null {
  if (x == null || x === "") return null;
  if (typeof x !== "string") throw new Error("bad_email");
  const e = x.trim().toLowerCase();
  if (!e) return null;
  if (!EMAIL.test(e) || e.length > 254 || e.endsWith("@users.yalla-sa.app")) throw new Error("bad_email");
  return e;
}

// new user's access (David 2026-11-19: a role per tool in the "new user" dialog). role = the deadhead role, or "none"/""
// for no deadhead access; tools = [{module, role}] for the other live tools ("none" rows dropped). Anything unknown: bad_input.
export function createGrants(b: Record<string, unknown>): { deadhead: string | null; tools: { module: string; role: string }[] } {
  const r = String(b.role ?? "");
  if (r && r !== "none" && !ROLES.includes(r)) throw new Error("bad_input");
  if (b.tools != null && !Array.isArray(b.tools)) throw new Error("bad_input");
  const byMod = new Map<string, string>();
  for (const t of (b.tools || []) as Record<string, unknown>[]) {
    const m = String(t?.module ?? ""), tr = String(t?.role ?? "");
    if (!TOOL_MODULES.includes(m) || !(tr === "none" || ROLES.includes(tr))) throw new Error("bad_input");
    if (tr === "none") byMod.delete(m); else byMod.set(m, tr);
  }
  return { deadhead: r && r !== "none" ? r : null, tools: [...byMod].map(([module, role]) => ({ module, role })) };
}
