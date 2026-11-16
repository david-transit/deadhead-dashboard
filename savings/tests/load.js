// Test helper: loads real day files (encrypted, as deployed) with the local data key. Never writes plaintext.
// Key: $DATA_KEY_FILE or ../dashboard/config/.data_key_<slug> (main checkout) or ./config/.data_key_<slug>.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..", "..");
// SAVINGS_DATA_DIR: another data folder, e.g. the main checkout's newer build (../dashboard/data)
const dataDir = () => process.env.SAVINGS_DATA_DIR || path.join(ROOT, "data");
function keyFile(slug) {
  const c = [process.env.DATA_KEY_FILE, path.join(ROOT, "config", `.data_key_${slug}`), path.join(ROOT, "..", "dashboard", "config", `.data_key_${slug}`)];
  return c.find(f => f && fs.existsSync(f)) || null;
}
function loadDay(slug, day) {
  const kf = keyFile(slug); if (!kf) return null;
  const f = path.join(dataDir(), slug, `day_${day}.js`); if (!fs.existsSync(f)) return null;
  const key = Buffer.from(fs.readFileSync(kf, "utf8").trim(), "base64");
  const m = fs.readFileSync(f, "utf8").match(/iv:"([^"]+)",ct:"([^"]+)"/);
  const ct = Buffer.from(m[2], "base64"), d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(m[1], "base64"));
  d.setAuthTag(ct.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]).toString("utf8"));
}
function listDays(slug) {
  const dir = path.join(dataDir(), slug); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(f => /^day_(\d{4}-\d{2}-\d{2})\.js$/.exec(f)).filter(Boolean).map(m => m[1]).sort();
}
module.exports = { loadDay, listDays, keyFile };
