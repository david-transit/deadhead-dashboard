// Bus vs car review (David, 2026-11-16): every unique empty leg of the built days routed three ways, with geometry.
//   node pipeline/osrm/compare.js <keyfile> <data dir> <out.js>
// Reads data/<slug>/day_*.js (decrypted in memory), routes each unique pair (a, b, terminal flags) with
//   strict  : our bus-strict OSRM on 127.0.0.1:5000 through assets/route.js smart() (exactly what the nightly would do)
//   relaxed : our bus-relaxed OSRM on 127.0.0.1:5001, plain route (ways the strict profile blocks are marked "dimlimit")
//   car     : the public car OSRM, plain route (no snapping check), for reference
// and writes the result ENCRYPTED with the operator key (same format as a day file, name "bus-compare"); the repository
// is public, so nothing in plaintext leaves the runner. Decrypt locally: node pipeline/decrypt.js <key> <out.js>.
const fs = require("fs"), path = require("path");
const K = require(path.join(__dirname, "..", "keys"));
const ROUTE = require(path.join(__dirname, "..", "..", "assets", "route.js"));
const PUBLIC = "https://router.project-osrm.org", STRICT = "http://127.0.0.1:5000", RELAXED = "http://127.0.0.1:5001";
const [keyFile, dir, out] = process.argv.slice(2);
const { kid, key } = K.readKeyFile(keyFile), ring = K.keyring([keyFile]);

async function getJ(u, ms) {
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(u, { signal: ctl.signal }); if (!r.ok && r.status !== 400) throw new Error("osrm " + r.status); return await r.json(); }
  finally { clearTimeout(tm); }
}
const pause = ms => new Promise(r => setTimeout(r, ms));
async function get(u, ms, gap) {
  for (let t = 0; t < 4; t++) { try { const j = await getJ(u, ms); if (gap) await pause(gap); return j; } catch (e) { await pause(1500 * (t + 1)); } }
  return null;
}
const ll = p => `${(+p[1]).toFixed(6)},${(+p[0]).toFixed(6)}`;
const plain = async (base, a, b, curb, gap) => {
  const j = await get(`${base}/route/v1/driving/${ll(a)};${ll(b)}?overview=full&geometries=polyline6&steps=true${curb ? "&approaches=curb;curb" : ""}`, 20000, gap);
  if (!j || j.code !== "Ok") return j ? { code: j.code } : null;
  const r = j.routes[0], steps = r.legs.flatMap(l => l.steps || []);
  const names = [...new Set(steps.map(s => [s.name, s.ref].filter(Boolean).join(" ")).filter(Boolean))];
  const dim = [...new Set(steps.map(s => s.ref || "").filter(x => x.startsWith("dimlimit")))];
  const uturn = steps.some(s => s.maneuver && s.maneuver.modifier === "uturn" && s.maneuver.type !== "depart" && s.maneuver.type !== "arrive");
  return { km: +(r.distance / 1000).toFixed(3), min: +(r.duration / 60).toFixed(2), g: r.geometry, names, dim, uturn,
           s: j.waypoints.map(w => Math.round(w.distance || 0)) };
};

(async () => {
  const t0 = Date.now(), pairs = new Map();
  for (const f of fs.readdirSync(dir).filter(f => /^day_\d{4}-\d{2}-\d{2}\.js$/.test(f)).sort()) {
    const J = JSON.parse(K.decryptEnc(K.readEnc(fs.readFileSync(path.join(dir, f), "utf8")), ring));
    for (const v of J.vehicles) for (const i of v.items) {
      if (i.kind !== "empty" || !i.a || !i.b || i.overlap) continue;
      const k = `${(+i.a[0]).toFixed(5)},${(+i.a[1]).toFixed(5)};${(+i.b[0]).toFixed(5)},${(+i.b[1]).toFixed(5)}`;
      const term = [!i.frm.startsWith("ליד") && !i.frm.startsWith("מיקום"), !i.to.startsWith("ליד") && !i.to.startsWith("מיקום")];
      const p = pairs.get(k) || { k, a: i.a, b: i.b, t: term, frm: i.frm, to: i.to, legs: [] };
      p.legs.push([J.day, v.veh, i.start, i.km, i.drive_min, i.rt || null, i.est ? 1 : 0, i.end - i.start]);
      pairs.set(k, p);
    }
  }
  console.log("unique pairs", pairs.size);
  const strict = ROUTE.make({ gapMs: 0, fetch: u => getJ(u.replace(PUBLIC, STRICT), 10000) });
  const L = [...pairs.values()]; let n = 0;
  for (const p of L) {
    if (ROUTE.hav(p.a, p.b) < 0.05) { p.same = 1; continue; }
    try {
      const r = await strict.smart(p.a, p.b, { terminal: p.t });
      if (r) {
        const A = (r.via && r.via[0]) || p.a, B = (r.via && r.via[1]) || p.b;
        p.bus = Object.assign(r, { geo: await plain(STRICT, A, B, r.fix === "curb", 0) });
      } else p.bus = null;
    } catch (e) { p.bus = { err: String(e.message || e) }; }
    p.relaxed = await plain(RELAXED, p.a, p.b, false, 0);
    p.strict_plain = await plain(STRICT, p.a, p.b, false, 0);
    p.car = await plain(PUBLIC, p.a, p.b, false, 150);
    if (++n % 250 === 0) console.log("routed", n, "of", L.length, Math.round((Date.now() - t0) / 1000), "s");
  }
  const plainText = Buffer.from(JSON.stringify({ built: new Date().toISOString(), pairs: L }));
  fs.writeFileSync(out, K.encryptEnc(plainText, kid, key, "ENC_DAY", "bus-compare"));
  console.log("done", L.length, "pairs in", Math.round((Date.now() - t0) / 1000), "s;",
              L.filter(p => p.bus && p.bus.km != null).length, "bus ok,", L.filter(p => p.car && p.car.km != null).length, "car ok");
})().catch(e => { console.error(e); process.exit(1); });
