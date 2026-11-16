// node decrypt.js <keyfile> <day_X.js>  ->  prints the day's plaintext JSON to stdout (used to read the previous day)
const fs = require("fs"), crypto = require("crypto");
const [keyFile, file] = process.argv.slice(2);
const key = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64");
const m = fs.readFileSync(file, "utf8").match(/iv:"([^"]+)",ct:"([^"]+)"/);
if (!m) throw new Error("not an encrypted day file");
const ct = Buffer.from(m[2], "base64"), d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(m[1], "base64"));
d.setAuthTag(ct.subarray(-16));
process.stdout.write(Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]));
