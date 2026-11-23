// node --test tests/portal-entry.test.js · the three sign-in steps that left the tool for the yalla-sa portal
// (David 23.11.2026, platform map §7.3: no sign-in screen in a tool, not even as a fallback)
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { portalEntry } = require("../assets/portal-entry.js");

const P = "https://yalla-sa.app/", PATH = "/deadhead-dashboard/";
const go = (hash, search = "") => portalEntry(hash, search, P, PATH);

test("1. invalid or expired mail link: the portal shows the error, then comes back here", () => {
  const u = go("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired", "?day=2026-11-20");
  assert.equal(u, P + "?err=mail_link&next=" + encodeURIComponent("/deadhead-dashboard/?day=2026-11-20"));
  // Supabase may also put the error in the query string; it is not carried into next
  assert.equal(go("", "?error=access_denied&error_description=expired"), P + "?err=mail_link&next=" + encodeURIComponent(PATH));
  // only a fixed code goes to the portal, never the text from the address bar
  assert.ok(!go("#error_description=%3Cscript%3E").includes("script"));
});

test("2. reset-password mail: the whole hash (the mail's session) goes on to the portal", () => {
  const h = "#access_token=eyJ.a+b/c&expires_at=1&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery";
  assert.equal(go(h), P + h);
  assert.equal(go("#type=recovery"), ""); // no token: nothing to hand over, the usual entry follows
});

test("3. recovery code: the portal's code step, back here afterwards", () => {
  assert.equal(go("", "?recover=1"), P + "?recover=1&next=" + encodeURIComponent(PATH));
  assert.equal(go("", "?recover=1&op=derech-egged"), P + "?recover=1&next=" + encodeURIComponent(PATH + "?op=derech-egged"));
});

test("anything else stays in the tool (no session -> toPortal, as before)", () => {
  assert.equal(go("", ""), "");
  assert.equal(go("", "?day=2026-11-20&veh=123"), "");
  assert.equal(go("#x=1", "?recover=0"), "");
});
