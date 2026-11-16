// node encrypt.js <keyfile> <datadir> <name...>  (AES-256-GCM, key file "<kid>:<base64>", see keys.js)
//   name = a day YYYY-MM-DD: day_<day>.json -> day_<day>.js, window.ENC_DAY[day]
//   name = ends_YYYY-MM (cross-day index of where each vehicle starts/ends): ends_YYYY-MM.json -> .js, window.ENC_ENDS["YYYY-MM"]
const fs = require("fs"), path = require("path"), K = require("./keys");
const [keyFile, dir, ...names] = process.argv.slice(2);
const { kid, key } = K.readKeyFile(keyFile);
for (const name of names) {
  const ends = name.startsWith("ends_"), base = ends ? name : `day_${name}`;
  const plain = fs.readFileSync(path.join(dir, `${base}.json`));
  fs.writeFileSync(path.join(dir, `${base}.js`), K.encryptEnc(plain, kid, key, ends ? "ENC_ENDS" : "ENC_DAY", ends ? name.slice(5) : name));
}
