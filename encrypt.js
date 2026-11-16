// node encrypt.js <keyfile> <datadir> <day...>  ->  writes <datadir>/day_<day>.js (encrypted, AES-256-GCM)
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [keyFile, dir, ...days] = process.argv.slice(2);
const key = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64");
if (key.length !== 32) throw new Error("bad key");
for (const day of days) {
  const plain = fs.readFileSync(path.join(dir, `day_${day}.json`));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]); // WebCrypto expects ciphertext||tag
  fs.writeFileSync(path.join(dir, `day_${day}.js`),
    `(window.ENC_DAY=window.ENC_DAY||{})[${JSON.stringify(day)}]={iv:"${iv.toString("base64")}",ct:"${ct.toString("base64")}"};\n`);
}
