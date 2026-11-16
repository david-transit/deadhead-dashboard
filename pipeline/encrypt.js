// node encrypt.js <keyfile> <datadir> <name...>  (AES-256-GCM)
//   name = a day YYYY-MM-DD: day_<day>.json -> day_<day>.js, window.ENC_DAY[day]
//   name = ends_YYYY-MM (cross-day index of where each vehicle starts/ends): ends_YYYY-MM.json -> .js, window.ENC_ENDS["YYYY-MM"]
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [keyFile, dir, ...names] = process.argv.slice(2);
const key = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64");
if (key.length !== 32) throw new Error("bad key");
for (const name of names) {
  const ends = name.startsWith("ends_"), base = ends ? name : `day_${name}`;
  const plain = fs.readFileSync(path.join(dir, `${base}.json`));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]); // WebCrypto expects ciphertext||tag
  const g = ends ? "ENC_ENDS" : "ENC_DAY", k = ends ? name.slice(5) : name;
  fs.writeFileSync(path.join(dir, `${base}.js`),
    `(window.${g}=window.${g}||{})[${JSON.stringify(k)}]={iv:"${iv.toString("base64")}",ct:"${ct.toString("base64")}"};\n`);
}
