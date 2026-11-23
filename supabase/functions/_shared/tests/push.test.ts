import { test } from "node:test";
import assert from "node:assert/strict";
import { b64u, encryptPayload, vapidHeader, sendPush, pushToAgents, isPushEndpoint, PUSH_TITLE } from "../push.ts";

// RFC 8291 Appendix A
const V = {
  plain: "When I grow up, I want to be a watermelon",
  asPub: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPriv: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPub: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  cipher: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

test("aes128gcm encryption matches RFC 8291 Appendix A byte for byte", async () => {
  const body = await encryptPayload(V.plain, V.uaPub, V.auth, { salt: b64u.dec(V.salt), asPub: V.asPub, asPriv: V.asPriv });
  const want = new Uint8Array([...b64u.dec(V.header), ...b64u.dec(V.cipher)]);
  assert.equal(b64u.enc(body), b64u.enc(want));
});

test("random salt and key by default: two encryptions differ, length = 86 header + text + 1 + 16 tag", async () => {
  const a = await encryptPayload("x", V.uaPub, V.auth), b = await encryptPayload("x", V.uaPub, V.auth);
  assert.notEqual(b64u.enc(a), b64u.enc(b));
  assert.equal(a.length, 86 + 1 + 1 + 16);
});

test("VAPID header: ES256 JWT for the endpoint origin, verifiable with the public key", async () => {
  const now = new Date("2026-11-22T10:00:00Z");
  const h = await vapidHeader("https://web.push.apple.com/abc/def", { publicKey: V.asPub, privateKey: V.asPriv }, now);
  const m = h.match(/^vapid t=([^,]+), k=(.+)$/)!;
  assert.ok(m);
  assert.equal(m[2], V.asPub);
  const [hd, cl, sig] = m[1].split(".");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64u.dec(hd))), { typ: "JWT", alg: "ES256" });
  const c = JSON.parse(new TextDecoder().decode(b64u.dec(cl)));
  assert.equal(c.aud, "https://web.push.apple.com");
  assert.equal(c.sub, "mailto:support@yalla-sa.app");
  assert.equal(c.exp, Math.floor(now.getTime() / 1000) + 12 * 3600);
  const raw = b64u.dec(V.asPub);
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: b64u.enc(raw.slice(1, 33)), y: b64u.enc(raw.slice(33)) },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64u.dec(sig), new TextEncoder().encode(`${hd}.${cl}`)));
});

const SUB = { id: "s1", endpoint: "https://fcm.googleapis.com/fcm/send/xyz", p256dh: V.uaPub, auth: V.auth };
const KEYS = { publicKey: V.asPub, privateKey: V.asPriv };
const fakeFetch = (status: number, calls: any[] = []) => (async (url: string, init: any) => { calls.push({ url, init }); return new Response(null, { status }); }) as any;

test("sendPush: headers, ok on 201, gone on 404/410, error otherwise", async () => {
  const calls: any[] = [];
  assert.equal(await sendPush(SUB, "{}", KEYS, fakeFetch(201, calls)), "ok");
  const h = calls[0].init.headers;
  assert.equal(calls[0].url, SUB.endpoint);
  assert.equal(h["Content-Encoding"], "aes128gcm");
  assert.equal(h.TTL, "86400");
  assert.equal(h.Urgency, "high");
  assert.match(h.Authorization, /^vapid t=/);
  assert.equal(await sendPush(SUB, "{}", KEYS, fakeFetch(410)), "gone");
  assert.equal(await sendPush(SUB, "{}", KEYS, fakeFetch(404)), "gone");
  assert.equal(await sendPush(SUB, "{}", KEYS, fakeFetch(500)), "error");
  assert.equal(await sendPush(SUB, "{}", KEYS, (async () => { throw new Error("net"); }) as any), "error");
});

test("pushToAgents: sends to every device, removes gone ones, payload has no details beyond the text", async () => {
  const removed: string[][] = [];
  const subs = [SUB, { ...SUB, id: "s2", endpoint: "https://web.push.apple.com/gone" }];
  const calls: any[] = [];
  const f = (async (url: string, init: any) => { calls.push({ url, init }); return new Response(null, { status: url.endsWith("gone") ? 410 : 201 }); }) as any;
  const r = await pushToAgents({ list: async () => subs, remove: async (ids) => { removed.push(ids); } }, "פנייה חדשה במייל", KEYS, f);
  assert.deepEqual(r, { ok: true, sent: 1, gone: 1 });
  assert.deepEqual(removed, [["s2"]]);
  assert.equal(calls.length, 2);
});

test("pushToAgents: no devices -> push_no_devices; missing keys -> not_configured", async () => {
  assert.deepEqual(await pushToAgents({ list: async () => [], remove: async () => {} }, "x", KEYS, fakeFetch(201)),
    { ok: false, error: "push_no_devices" });
  assert.deepEqual(await pushToAgents({ list: async () => [SUB], remove: async () => {} }, "x", { publicKey: "", privateKey: "" }, fakeFetch(201)),
    { ok: false, error: "push_not_configured" });
});

test("pushToAgents: all devices failing -> ok false", async () => {
  const r = await pushToAgents({ list: async () => [SUB], remove: async () => {} }, "x", KEYS, fakeFetch(500));
  assert.deepEqual(r, { ok: false, error: "push_failed", sent: 0, gone: 0 });
});

test("isPushEndpoint: only https on known push services", () => {
  for (const u of ["https://fcm.googleapis.com/fcm/send/a", "https://web.push.apple.com/QA", "https://api.push.apple.com/x",
    "https://updates.push.services.mozilla.com/wpush/v2/x", "https://wns2-par02p.notify.windows.com/w/?token=x"]) assert.ok(isPushEndpoint(u), u);
  for (const u of ["http://fcm.googleapis.com/x", "https://evil.com/fcm.googleapis.com", "https://fcm.googleapis.com.evil.com/x",
    "https://169.254.169.254/", "not a url", "https://push.apple.com.evil.io/"]) assert.ok(!isPushEndpoint(u), u);
});

test("title is the brand only", () => { assert.equal(PUSH_TITLE, "יאללה־סע"); });

test("vapidPairOk: true for a matching pair, false for a mismatched or malformed public key", async () => {
  const { vapidPairOk } = await import("../push.ts");
  assert.equal(await vapidPairOk(KEYS), true);
  assert.equal(await vapidPairOk({ publicKey: V.uaPub, privateKey: V.asPriv }), false);
  assert.equal(await vapidPairOk({ publicKey: "abc", privateKey: V.asPriv }), false);
});
