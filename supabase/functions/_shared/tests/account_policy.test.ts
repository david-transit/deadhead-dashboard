import { test } from "node:test";
import assert from "node:assert/strict";
import { PLATFORM_ONLY, writeAllowed, tempExpiry, tempExpired, cleanContactEmail, moveInputOk } from "../account/policy.ts";

test("platform-only action list", () => {
  assert.deepEqual([...PLATFORM_ONLY].sort(), ["create", "delete", "get_contact_email", "move_operator", "remove_membership", "remove_tool_role", "reset_mfa", "reset_password",
    "send_details", "set_contact_email", "set_disabled", "set_membership", "set_platform", "set_tool_role"]);
});
test("operator admin: every write is refused", () => {
  for (const a of PLATFORM_ONLY) assert.equal(writeAllowed(a, false, false), false, a);
  assert.equal(writeAllowed("set_name", false, false), false);
});
test("operator admin: self id does not open other writes", () => {
  for (const a of PLATFORM_ONLY) assert.equal(writeAllowed(a, false, true), false, a);
});
test("platform admin: all allowed; anyone may rename self; list open", () => {
  for (const a of PLATFORM_ONLY) assert.equal(writeAllowed(a, true, false), true, a);
  assert.equal(writeAllowed("set_name", false, true), true);
  assert.equal(writeAllowed("set_name", true, false), true);
  assert.equal(writeAllowed("list", false, false), true);
});
test("tempExpiry: +7 days", () => assert.equal(tempExpiry(new Date("2026-11-19T10:00:00Z")).toISOString(), "2026-11-26T10:00:00.000Z"));
test("tempExpired", () => {
  const now = new Date("2026-11-27T00:00:00Z");
  assert.equal(tempExpired({ must_change_password: true, temp_password_expires_at: "2026-11-26T10:00:00Z" }, now), true);
  assert.equal(tempExpired({ must_change_password: true, temp_password_expires_at: "2026-11-28T10:00:00Z" }, now), false);
  assert.equal(tempExpired({ must_change_password: true, temp_password_expires_at: null }, now), false); // existing users: no expiry
  assert.equal(tempExpired({ must_change_password: false, temp_password_expires_at: "2026-11-26T10:00:00Z" }, now), false);
});
test("cleanContactEmail", () => {
  assert.equal(cleanContactEmail(" Avi@Gmail.com "), "avi@gmail.com");
  assert.equal(cleanContactEmail(""), null); assert.equal(cleanContactEmail(null), null); assert.equal(cleanContactEmail(undefined), null);
  for (const bad of ["x", "a@b", "a b@c.co", "avi@users.yalla-sa.app", "AVI@Users.Yalla-Sa.App", "a".repeat(250) + "@b.co", 5])
    assert.throws(() => cleanContactEmail(bad), /bad_email/, String(bad));
});

import { createGrants } from "../account/policy.ts";
test("createGrants: deadhead role + tool roles", () => {
  assert.deepEqual(createGrants({ role: "editor", tools: [{ module: "studio", role: "viewer" }] }),
    { deadhead: "editor", tools: [{ module: "studio", role: "viewer" }] });
});
test("createGrants: no deadhead access ('none' or empty), tool only", () => {
  assert.deepEqual(createGrants({ role: "none", tools: [{ module: "studio", role: "admin" }] }), { deadhead: null, tools: [{ module: "studio", role: "admin" }] });
  assert.deepEqual(createGrants({ role: "", tools: [] }), { deadhead: null, tools: [] });
});
test("createGrants: old portal (no tools field) keeps working", () => {
  assert.deepEqual(createGrants({ role: "viewer" }), { deadhead: "viewer", tools: [] });
});
test("createGrants: 'none' tool rows are dropped; duplicates keep the last", () => {
  assert.deepEqual(createGrants({ role: "none", tools: [{ module: "studio", role: "none" }] }), { deadhead: null, tools: [] });
  assert.deepEqual(createGrants({ role: "none", tools: [{ module: "studio", role: "viewer" }, { module: "studio", role: "editor" }] }).tools, [{ module: "studio", role: "editor" }]);
});
test("createGrants: unknown module or role -> bad_input", () => {
  for (const b of [{ role: "boss" }, { role: "none", tools: [{ module: "deadhead", role: "viewer" }] }, { role: "none", tools: [{ module: "x", role: "viewer" }] },
    { role: "none", tools: [{ module: "studio", role: "owner" }] }, { role: "none", tools: "studio" }])
    assert.throws(() => createGrants(b as Record<string, unknown>), /bad_input/, JSON.stringify(b));
});

test("move_operator: platform admin only", () => {
  assert.equal(writeAllowed("move_operator", false, false), false);
  assert.equal(writeAllowed("move_operator", false, true), false);
  assert.equal(writeAllowed("move_operator", true, false), true);
});
test("move_operator input: two different uuids", () => {
  const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
  assert.equal(moveInputOk(a, b), true);
  assert.equal(moveInputOk(a, a), false);
  assert.equal(moveInputOk(a, "op2"), false);
  assert.equal(moveInputOk(undefined, b), false);
});
