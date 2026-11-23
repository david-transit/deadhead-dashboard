// Web Push alerts to support agents (PRD-email M20, design 2026-11-22-email-push-alerts-design.md §3).
// WebCrypto only (no library): RFC 8291 payload encryption (aes128gcm, RFC 8188) and RFC 8292 VAPID (ES256 JWT).
// Pure: runs in Deno Edge Functions and in Node tests. The text carries no name and no content (M9, R3א).
export const PUSH_TITLE = "יאללה־סע";
export const PUSH_URL = "/support/";
export const VAPID_SUB = "mailto:support@yalla-sa.app";

export interface PushSub { id: string; endpoint: string; p256dh: string; auth: string }
export interface VapidKeys { publicKey: string; privateKey: string } // base64url: raw 65-byte point, 32-byte d
export type PushResult = "ok" | "gone" | "error";

export const b64u = {
  enc(b: Uint8Array): string {
    let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(s: string): Uint8Array {
    const t = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(t + "===".slice((t.length + 3) % 4));
    const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
  },
};
const te = new TextEncoder();
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const subtle = () => crypto.subtle;

function jwkOf(pubRaw: Uint8Array, d?: Uint8Array): JsonWebKey {
  const j: JsonWebKey = { kty: "EC", crv: "P-256", x: b64u.enc(pubRaw.slice(1, 33)), y: b64u.enc(pubRaw.slice(33, 65)) };
  if (d) j.d = b64u.enc(d);
  return j;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

// RFC 8291 §3.4 + RFC 8188, one record. `fixed` is for the RFC test vector only.
export async function encryptPayload(text: string, uaPublic: string, authSecret: string,
  fixed?: { salt: Uint8Array; asPub: string; asPriv: string }): Promise<Uint8Array> {
  const ua = b64u.dec(uaPublic);
  if (ua.length !== 65 || ua[0] !== 4) throw new Error("bad_p256dh");
  let asPub: Uint8Array, asPrivKey: CryptoKey;
  if (fixed) {
    asPub = b64u.dec(fixed.asPub);
    asPrivKey = await subtle().importKey("jwk", jwkOf(asPub, b64u.dec(fixed.asPriv)), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } else {
    const kp = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    asPub = new Uint8Array(await subtle().exportKey("raw", kp.publicKey)); asPrivKey = kp.privateKey;
  }
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await subtle().importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: uaKey }, asPrivKey, 256));
  const ikm = await hkdf(b64u.dec(authSecret), ecdh, cat(te.encode("WebPush: info\0"), ua, asPub), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await subtle().importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce }, key, cat(te.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

// RFC 8292: Authorization header for one push service (aud = endpoint origin), valid 12 hours
export async function vapidHeader(endpoint: string, keys: VapidKeys, now = new Date()): Promise<string> {
  const pub = b64u.dec(keys.publicKey);
  const k = await subtle().importKey("jwk", jwkOf(pub, b64u.dec(keys.privateKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (o: unknown) => b64u.enc(te.encode(JSON.stringify(o)));
  const input = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: VAPID_SUB })}`;
  const sig = new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, k, te.encode(input)));
  return `vapid t=${input}.${b64u.enc(sig)}, k=${keys.publicKey}`;
}

export async function sendPush(sub: PushSub, payload: string, keys: VapidKeys, fetchFn: typeof fetch = fetch): Promise<PushResult> {
  try {
    const body = await encryptPayload(payload, sub.p256dh, sub.auth);
    const r = await fetchFn(sub.endpoint, { method: "POST", body, signal: AbortSignal.timeout(15000), headers: {
      "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high",
      Authorization: await vapidHeader(sub.endpoint, keys) } });
    if (r.status === 404 || r.status === 410) return "gone";
    if (!r.ok) console.error("push rejected", r.status, new URL(sub.endpoint).host, (await r.text().catch(() => "")).slice(0, 200));
    return r.ok ? "ok" : "error";
  } catch (e) { console.error("push failed", String(e).slice(0, 200)); return "error"; }
}

export interface PushStore { list(): Promise<PushSub[]>; remove(ids: string[]): Promise<void> }

// one alert to every subscribed device of every agent; devices the push service no longer knows are removed
export async function pushToAgents(store: PushStore, text: string, keys: VapidKeys, fetchFn: typeof fetch = fetch):
  Promise<{ ok: boolean; sent?: number; gone?: number; error?: string }> {
  if (!keys.publicKey || !keys.privateKey) return { ok: false, error: "push_not_configured" };
  const subs = await store.list();
  if (!subs.length) return { ok: false, error: "push_no_devices" };
  const payload = JSON.stringify({ title: PUSH_TITLE, body: text, url: PUSH_URL });
  const res = await Promise.all(subs.map((s) => sendPush(s, payload, keys, fetchFn)));
  const gone = subs.filter((_, i) => res[i] === "gone").map((s) => s.id);
  if (gone.length) await store.remove(gone);
  const sent = res.filter((r) => r === "ok").length;
  return sent ? { ok: true, sent, gone: gone.length } : { ok: false, error: "push_failed", sent, gone: gone.length };
}

// endpoints we accept from browsers: https on the push services of Apple, Google, Mozilla and Microsoft only
// (the server POSTs to this URL, so an open list would make it a request relay)
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/];
export function isPushEndpoint(u: string): boolean {
  try { const x = new URL(u); return x.protocol === "https:" && !x.port && PUSH_HOSTS.some((r) => r.test(x.hostname)); } catch { return false; }
}

// the two secrets belong together: sign with the private key, verify with the public one (reveals neither)
export async function vapidPairOk(keys: VapidKeys): Promise<boolean> {
  try {
    const pub = b64u.dec(keys.publicKey);
    if (pub.length !== 65 || pub[0] !== 4) return false;
    const h = await vapidHeader("https://fcm.googleapis.com/x", keys);
    const [hd, cl, sig] = h.slice(8, h.indexOf(", k=")).split(".");
    const k = await subtle().importKey("jwk", jwkOf(pub), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, k, b64u.dec(sig), te.encode(`${hd}.${cl}`));
  } catch { return false; }
}
