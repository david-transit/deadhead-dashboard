// Data keys (H1, key versions). A key file holds "<kid>:<base64 32 bytes>" (GitHub secret DATA_KEY* has the same text);
// an old file may hold the bare base64 (kid "k0"). The local keyring config/.keyring_<slug>.json = {kid: base64} keeps
// older keys so files can be re-encrypted during a rotation (pipeline/rotate_key.md). Never print a key.
const fs = require("fs");
function parseKey(text) {
  const t = text.trim(), m = t.match(/^(k[0-9a-z]{1,20}):(.+)$/);
  const kid = m ? m[1] : "k0", key = Buffer.from(m ? m[2] : t, "base64");
  if (key.length !== 32) throw new Error("bad key");
  return { kid, key };
}
const readKeyFile = (f) => parseKey(fs.readFileSync(f, "utf8"));
// all known keys: the key file(s) given + an optional keyring file (JSON {kid: base64})
function keyring(files) {
  const ring = {};
  for (const f of files) {
    if (!f || !fs.existsSync(f)) continue;
    const t = fs.readFileSync(f, "utf8").trim();
    if (t.startsWith("{")) for (const [kid, b] of Object.entries(JSON.parse(t))) ring[kid] = parseKey(`${kid}:${b}`).key;
    else { const k = parseKey(t); ring[k.kid] = k.key; }
  }
  return ring;
}
const FILE_RE = /^\(window\.(ENC_DAY|ENC_ENDS)=window\.\1\|\|\{\}\)\[("[^"]+")\]=(\{.*\});\s*$/s;
function readEnc(text) {
  const m = text.match(FILE_RE);
  if (!m) throw new Error("not an encrypted day/ends file");
  return { global: m[1], name: JSON.parse(m[2]), ...JSON.parse(m[3].replace(/([{,])(kid|iv|ct):/g, '$1"$2":')) };
}
function decryptEnc(e, ring) {
  const crypto = require("crypto");
  const ct = Buffer.from(e.ct, "base64"), keys = e.kid ? (ring[e.kid] ? [ring[e.kid]] : []) : Object.values(ring);
  for (const key of keys) {
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
      d.setAuthTag(ct.subarray(-16));
      return Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
    } catch {}
  }
  throw new Error(`no key decrypts this file (kid ${e.kid || "none"})`);
}
function encryptEnc(plain, kid, key, global, name) {
  const crypto = require("crypto"), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]); // WebCrypto expects ciphertext||tag
  return `(window.${global}=window.${global}||{})[${JSON.stringify(name)}]={kid:"${kid}",iv:"${iv.toString("base64")}",ct:"${ct.toString("base64")}"};\n`;
}
module.exports = { parseKey, readKeyFile, keyring, readEnc, decryptEnc, encryptEnc };
