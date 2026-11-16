// Rotate (or revoke) an operator's data key. Runbook: pipeline/rotate_key.md. Never prints a key.
//
//   node pipeline/rotate_key.js start  <slug>   one-time local PGP key + the SQL that makes the DB generate the new key
//   node pipeline/rotate_key.js apply  <slug>   unwrap the new key, re-encrypt every day/ends file, GitHub secret, push
//   node pipeline/rotate_key.js finish <slug>   SQL that retires the previous key (after GitHub Pages has the new files)
//
// With SUPABASE_ACCESS_TOKEN (a Supabase personal access token) in the environment, the SQL steps run by themselves
// through the Management API and "start" goes straight on to "apply". Without it, run the printed SQL file in the
// Supabase SQL editor and save its single result value as config/.rotate/<slug>/wrapped.asc.
const fs = require("fs"), path = require("path"), cp = require("child_process"), K = require("./keys");

const REPO = path.dirname(__dirname), PROJECT = "xghfcdgettrcdciwwzbl";
const [cmd, slug] = process.argv.slice(2);
const ops = JSON.parse(fs.readFileSync(path.join(__dirname, "operators.json"), "utf8")).operators;
const OP = ops.find((o) => o.slug === slug);
if (!["start", "apply", "finish"].includes(cmd) || !OP) {
  console.error("usage: node pipeline/rotate_key.js start|apply|finish <slug>   (slugs: " + ops.map((o) => o.slug).join(", ") + ")");
  process.exit(2);
}
const CFG = path.join(REPO, "config"), WORK = path.join(CFG, ".rotate", slug), GNUPG = path.join(WORK, "gnupg");
const KEYFILE = path.join(CFG, `.data_key_${slug}`), RING = path.join(CFG, `.keyring_${slug}.json`);
const DATA = path.join(REPO, "data", slug), STATE = path.join(WORK, "state.json");
const run = (c, a, o = {}) => cp.execFileSync(c, a, { cwd: REPO, stdio: ["pipe", "pipe", "inherit"], ...o });
const rel = (p) => path.relative(REPO, p).split(path.sep).join("/"); // Git-for-Windows gpg wants POSIX-style paths
const gpg = (a, o) => run("gpg", ["--homedir", rel(GNUPG), "--batch", "--quiet", ...a], o);
const sqlq = (s) => "'" + s.replace(/'/g, "''") + "'";

async function runSql(sql) { // Management API; returns rows or null when no token is set
  const tok = process.env.SUPABASE_ACCESS_TOKEN;
  if (!tok) return null;
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`Management API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
function nightlyRunning() {
  try { return JSON.parse(run("gh", ["run", "list", "--workflow", "nightly.yml", "--json", "status", "--limit", "5"]).toString()).some((x) => x.status !== "completed"); }
  catch { return false; }
}

async function start() {
  if (nightlyRunning()) throw new Error("the nightly workflow is running; try again when it has finished");
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(GNUPG, { recursive: true, mode: 0o700 });
  const d = new Date(), kid = "k" + d.toISOString().slice(0, 16).replace(/\D/g, ""); // k202611171030
  gpg(["--gen-key"], { input: "%no-protection\nKey-Type: RSA\nKey-Length: 3072\nKey-Usage: sign\nSubkey-Type: RSA\nSubkey-Length: 3072\nSubkey-Usage: encrypt\nName-Real: yalla-sa key rotation\nExpire-Date: 2d\n%commit\n" });
  const pub = gpg(["--armor", "--export"]).toString();
  if (!pub.includes("BEGIN PGP PUBLIC KEY")) throw new Error("gpg did not export a public key");
  const sql = `select private.rotate_data_key(${sqlq(slug)}, ${sqlq(kid)}, ${sqlq(pub)}) as wrapped;`;
  fs.writeFileSync(path.join(WORK, "rotate.sql"), sql);
  fs.writeFileSync(STATE, JSON.stringify({ kid, started: d.toISOString() }));
  const rows = await runSql(sql);
  if (rows) { fs.writeFileSync(path.join(WORK, "wrapped.asc"), rows[0].wrapped); console.log("DB generated key", kid); return apply(); }
  console.log(`new key id ${kid}. Next:\n 1. run ${path.join(WORK, "rotate.sql")} in the Supabase SQL editor\n` +
    ` 2. save the single result value (-----BEGIN PGP MESSAGE----- ...) as ${path.join(WORK, "wrapped.asc")}\n` +
    ` 3. node pipeline/rotate_key.js apply ${slug}`);
}

async function apply() {
  const { kid } = JSON.parse(fs.readFileSync(STATE, "utf8"));
  run("git", ["pull", "--rebase", "--quiet"], { stdio: "inherit" });
  const b64 = gpg(["--decrypt", rel(path.join(WORK, "wrapped.asc"))]).toString().trim();
  const fresh = K.parseKey(`${kid}:${b64}`); // throws unless 32 bytes
  // keyring: every key this machine has known for the operator (to read the files before re-encryption)
  const ring = K.keyring([RING, KEYFILE]);
  ring[kid] = fresh.key;
  const ringOut = {}; for (const [k, v] of Object.entries(ring)) ringOut[k] = v.toString("base64");
  fs.writeFileSync(RING, JSON.stringify(ringOut), { mode: 0o600 });

  fs.mkdirSync(DATA, { recursive: true });
  const days = fs.readdirSync(DATA).filter((f) => /^day_\d{4}-\d{2}-\d{2}\.js$/.test(f)).sort();
  const ends = fs.readdirSync(DATA).filter((f) => /^ends_\d{4}-\d{2}\.js$/.test(f)).sort();
  const sha = (f) => require("crypto").createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 10);
  const oldHash = {}, newHash = {};
  for (const f of days) {
    const p = path.join(DATA, f), e = K.readEnc(fs.readFileSync(p, "utf8"));
    oldHash[e.name] = sha(p);
    fs.writeFileSync(p, K.encryptEnc(K.decryptEnc(e, ring), kid, fresh.key, e.global, e.name));
    newHash[e.name] = sha(p);
  }
  for (const f of ends) { // the ends index records the hash of each day file it was built from: keep it in step
    const p = path.join(DATA, f), e = K.readEnc(fs.readFileSync(p, "utf8"));
    const idx = JSON.parse(K.decryptEnc(e, ring).toString("utf8"));
    for (const d of Object.keys(idx.ver || {})) if (idx.ver[d] === oldHash[d]) idx.ver[d] = newHash[d];
    fs.writeFileSync(p, K.encryptEnc(Buffer.from(JSON.stringify(idx)), kid, fresh.key, e.global, e.name));
  }
  // check: every file opens with the new key alone
  for (const f of [...days, ...ends]) K.decryptEnc(K.readEnc(fs.readFileSync(path.join(DATA, f), "utf8")), { [kid]: fresh.key });
  run("python", [path.join("pipeline", "build_day.py"), "--reindex", "--op", slug], { env: { ...process.env, PYTHONIOENCODING: "utf-8" }, stdio: "inherit" });
  console.log(`re-encrypted ${days.length} day files and ${ends.length} ends files with ${kid}`);

  fs.writeFileSync(KEYFILE + ".new", `${kid}:${b64}`, { mode: 0o600 });
  fs.renameSync(KEYFILE + ".new", KEYFILE);
  run("gh", ["secret", "set", OP.key_secret], { input: fs.readFileSync(KEYFILE) });
  console.log(`GitHub secret ${OP.key_secret} updated`);

  run("git", ["add", path.join("data", slug)]);
  run("git", ["commit", "-q", "-m", `Rotate data key ${slug} -> ${kid} (re-encrypt all day/ends files)`]);
  run("git", ["push", "-q"], { stdio: "inherit" });
  try { run("gpgconf", ["--homedir", rel(GNUPG), "--kill", "gpg-agent"]); } catch {}
  fs.rmSync(GNUPG, { recursive: true, force: true });
  console.log(`pushed. When GitHub Pages has deployed (a minute or two): node pipeline/rotate_key.js finish ${slug}`);
}

async function finish() {
  const { kid } = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
  const sql = `select private.retire_previous_keys(${sqlq(slug)}) as retired;`;
  const rows = await runSql(sql);
  if (rows) console.log("retired previous keys:", rows[0].retired);
  else { fs.mkdirSync(WORK, { recursive: true }); fs.writeFileSync(path.join(WORK, "finish.sql"), sql); console.log(`run in the Supabase SQL editor:\n  ${sql}`); }
  if (kid) console.log(`current key: ${kid}`);
}

({ start, apply, finish })[cmd]().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
