// node --test supabase/tests/access.test.mjs   (node >= 23.6 runs the .ts module directly)
// Per-tool roles (bug 2026-11-19: a studio role change also changed the deadhead role, and back).
import test from "node:test";
import assert from "node:assert/strict";
import { canManageUser, visibleOf, rolesForModule, TOOL_MODULES, CALLER_MODULE } from "../functions/_shared/access.ts";

const OP1 = "11111111-0000-0000-0000-000000000001", OP2 = "11111111-0000-0000-0000-000000000002";
const base = { caller: "me", target: "u", isPlatform: false, adminOps: new Set([OP1]), platformIds: new Set(), memberships: [], tools: [] };

test("tool_access reads only the caller's module: a deadhead role never leaks into studio", () => {
  const rows = [{ operator_id: OP1, module: "studio", role: "viewer" }, { operator_id: OP2, module: "notice-check", role: "editor" }];
  assert.deepEqual(rolesForModule(rows, CALLER_MODULE["transit-studio"]), [{ operator_id: OP1, role: "viewer" }]);
  assert.deepEqual(rolesForModule([], "studio"), []); // deadhead membership alone = no studio access
  assert.deepEqual(rolesForModule([{ operator_id: OP1, module: "studio", role: "owner" }], "studio"), []); // unknown role dropped
});

test("only known callers / tool modules; deadhead is never a tool_roles module", () => {
  assert.equal(CALLER_MODULE["transit-studio"], "studio");
  assert.equal(Object.hasOwn(CALLER_MODULE, "deadhead"), false);
  assert.equal(Object.hasOwn(CALLER_MODULE, "__proto__"), false);
  assert.deepEqual(TOOL_MODULES, ["studio", "notice-check", "notice-create"]);
});

test("notices tiles (2026-11-19): each notices module reads only its own role, never studio's or deadhead's", () => {
  assert.equal(CALLER_MODULE["notice-check"], "notice-check");
  assert.equal(CALLER_MODULE["notice-create"], "notice-create");
  const rows = [{ operator_id: OP1, module: "studio", role: "admin" }, { operator_id: OP1, module: "notice-check", role: "viewer" },
    { operator_id: OP2, module: "notice-create", role: "editor" }];
  assert.deepEqual(rolesForModule(rows, CALLER_MODULE["notice-check"]), [{ operator_id: OP1, role: "viewer" }]);
  assert.deepEqual(rolesForModule(rows, CALLER_MODULE["notice-create"]), [{ operator_id: OP2, role: "editor" }]);
  assert.deepEqual(rolesForModule(rows, CALLER_MODULE["transit-studio"]), [{ operator_id: OP1, role: "admin" }]);
  assert.deepEqual(rolesForModule([{ operator_id: OP1, module: "studio", role: "editor" }], "notice-check"), []); // no backfill: studio role != notices
});

test("operator admin manages a notices-only user of his operator", () => {
  assert.equal(canManageUser({ ...base, tools: [{ operator_id: OP1, module: "notice-create", role: "editor" }] }), true);
  assert.equal(canManageUser({ ...base, tools: [{ operator_id: OP2, module: "notice-check", role: "viewer" }] }), false);
});

test("operator admin manages a studio-only user of his operator", () => {
  assert.equal(canManageUser({ ...base, tools: [{ operator_id: OP1, module: "studio", role: "editor" }] }), true);
});

test("operator admin cannot manage a user whose studio role is admin, or is in another operator", () => {
  assert.equal(canManageUser({ ...base, memberships: [{ operator_id: OP1, role: "viewer" }], tools: [{ operator_id: OP1, module: "studio", role: "admin" }] }), false);
  assert.equal(canManageUser({ ...base, memberships: [{ operator_id: OP1, role: "viewer" }], tools: [{ operator_id: OP2, module: "studio", role: "viewer" }] }), false);
});

test("no access at all, self, platform admins", () => {
  assert.equal(canManageUser(base), false);
  assert.equal(canManageUser({ ...base, target: "me", memberships: [{ operator_id: OP1, role: "viewer" }] }), false);
  assert.equal(canManageUser({ ...base, platformIds: new Set(["u"]), memberships: [{ operator_id: OP1, role: "viewer" }] }), false);
  assert.equal(canManageUser({ ...base, isPlatform: true }), true);
});

test("visibility: operator admin sees only his operators' grants", () => {
  const g = [{ operator_id: OP1, role: "viewer" }, { operator_id: OP2, role: "editor" }];
  assert.deepEqual(visibleOf(false, new Set([OP1]), g), [g[0]]);
  assert.deepEqual(visibleOf(true, new Set(), g), g);
});
