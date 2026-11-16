// node decrypt.js <keyfile[,keyring.json,...]> <day_X.js or ends_YYYY-MM.js>  ->  prints the plaintext JSON to stdout
const fs = require("fs"), K = require("./keys");
const [keyFiles, file] = process.argv.slice(2);
const ring = K.keyring(keyFiles.split(","));
process.stdout.write(K.decryptEnc(K.readEnc(fs.readFileSync(file, "utf8")), ring));
