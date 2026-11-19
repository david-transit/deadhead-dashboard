// Shared access rules (yalla-sa): pure functions, no I/O, so they are unit-tested in node (supabase/tests).
// memberships.role = the deadhead tool's role (and operator 'admin' = the operator's user manager in the panel);
// tool_roles = the role in every other live tool, separate per tool (migration 20261119120000_tool_roles.sql).

export const ROLES = ["viewer", "editor", "admin"];
// tools whose role lives in tool_roles (the portal's tiles.json "module"); deadhead stays in memberships
export const TOOL_MODULES = ["studio"];
// tool_access callers (allow-list) -> the module whose role they read
export const CALLER_MODULE: Record<string, string> = { "transit-studio": "studio" };

export type Grant = { operator_id: string; role: string };
export type ToolGrant = Grant & { module: string };

// May the caller reset / disable / delete / re-assign this user? A platform admin: everyone but himself.
// An operator admin: users whose every access (deadhead and every tool) is in operators he administers, and who are
// not an admin anywhere (another admin is managed by a platform admin, L2), and who are not platform admins.
export function canManageUser(o: {
  caller: string; target: string; isPlatform: boolean; adminOps: Set<string>; platformIds: Set<string>;
  memberships: Grant[]; tools: ToolGrant[];
}): boolean {
  if (!o.target || o.target === o.caller) return false;
  if (o.isPlatform) return true;
  if (o.platformIds.has(o.target)) return false;
  const all: Grant[] = [...o.memberships, ...o.tools];
  return all.length > 0 && all.every((g) => o.adminOps.has(g.operator_id) && g.role !== "admin");
}

// what the caller may see of a user's access (platform: all; operator admin: his operators only)
export function visibleOf<T extends Grant>(isPlatform: boolean, adminOps: Set<string>, grants: T[]): T[] {
  return isPlatform ? grants : grants.filter((g) => adminOps.has(g.operator_id));
}

// tool_access answer: the roles of one module, valid roles only
export function rolesForModule(rows: ToolGrant[], module: string): Grant[] {
  return rows.filter((r) => r.module === module && ROLES.includes(r.role)).map((r) => ({ operator_id: r.operator_id, role: r.role }));
}
