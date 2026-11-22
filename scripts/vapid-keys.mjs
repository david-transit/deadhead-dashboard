// Creates the VAPID key pair for push alerts (PRD-email M20). Run by David only.
// Prints the PUBLIC key (safe to see) and copies the PRIVATE key to the clipboard without showing it.
import { webcrypto as c } from "node:crypto";
import { execSync } from "node:child_process";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const kp = await c.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = b64u(new Uint8Array(await c.subtle.exportKey("raw", kp.publicKey)));
const { d } = await c.subtle.exportKey("jwk", kp.privateKey);
execSync("clip", { input: d });
console.log("\nVAPID_PUBLIC_KEY (מותר לראות):\n" + pub);
console.log("\nVAPID_PRIVATE_KEY הועתק ללוח. הדבק אותו ב-Supabase עכשיו, לפני שמעתיקים משהו אחר.\n");
