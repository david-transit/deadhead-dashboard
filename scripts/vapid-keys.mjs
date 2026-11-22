// Creates the VAPID key pair for push alerts (PRD-email M20). Run by David only.
// Puts each key on the clipboard in turn, so nothing has to be selected by hand. The private key is never shown.
import { webcrypto as c } from "node:crypto";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const kp = await c.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = b64u(new Uint8Array(await c.subtle.exportKey("raw", kp.publicKey)));
const { d } = await c.subtle.exportKey("jwk", kp.privateKey);
const rl = createInterface({ input: process.stdin, output: process.stdout });
execSync("clip", { input: d });
await rl.question("\n1) המפתח הסודי הועתק ללוח. הדבק אותו בתיבת הערך של VAPID_PRIVATE_KEY, ואז חזור לכאן ולחץ Enter ");
execSync("clip", { input: pub });
await rl.question("\n2) המפתח הציבורי הועתק ללוח. הדבק אותו בתיבת הערך של VAPID_PUBLIC_KEY, ואז חזור לכאן ולחץ Enter ");
execSync("clip", { input: " " });
rl.close();
console.log("\n3) עכשיו לחץ Save ב-Supabase. הלוח נוקה.\n");
