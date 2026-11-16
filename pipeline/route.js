// Batch road routing for the pipeline: one JSON request per stdin line {a:[lat,lon], b:[lat,lon], t:[bool,bool]},
// one JSON answer per stdout line (assets/route.js smart(); null when OSRM has no route / is unavailable).
//
// Which OSRM (env, pipeline/osrm/README.md):
//   OSRM_BASE     our own osrm-routed (the nightly starts one on 127.0.0.1:5000 with the bus-strict profile); empty =
//                 the public car server only, as before.
//   OSRM_PROFILE  the profile OSRM_BASE was built with (default "bus-strict"); written into the answer as p.
//   OSRM_DOWN     "true" when the nightly could not start our server: every leg goes to the fallback at once.
// Every answer says how it was routed: p = OSRM_PROFILE, or p = "car" + fb = 1 when our server failed or had no route
// and the public car server was used instead (shown as "חושב ברכב פרטי (גיבוי)"). assets/route.js is not changed: the
// base URL is swapped in the fetch function it accepts (make({fetch})).
const path = require("path"), readline = require("readline");
const ROUTE = require(path.join(__dirname, "..", "assets", "route.js"));
const PUBLIC = "https://router.project-osrm.org";
const LOCAL = (process.env.OSRM_BASE || "").replace(/\/+$/, "");
const PROFILE = process.env.OSRM_PROFILE || "bus-strict";

async function fetchJ(u, ms) { // like assets/route.js: 400 carries an OSRM answer (NoRoute, ...)
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(u, { signal: ctl.signal }); if (!r.ok && r.status !== 400) throw new Error("osrm " + r.status); return await r.json(); }
  finally { clearTimeout(tm); }
}

let R;
if (!LOCAL) {
  const car = ROUTE.make();
  R = { smart: async (a, b, o) => { const r = await car.smart(a, b, o); return r && Object.assign(r, { p: "car" }); } };
} else {
  // our server: no pause between requests, short timeout; a connection error counts towards "down"
  let down = process.env.OSRM_DOWN === "true" ? 20 : 0; // the nightly could not start it: straight to the fallback
  const local = ROUTE.make({ gapMs: 0, fetch: async u => {
    try { const j = await fetchJ(u.replace(PUBLIC, LOCAL), 10000); down = 0; return j; }
    catch (e) { down++; throw e; } } });
  const car = ROUTE.make();
  R = { smart: async (a, b, o) => {
    if (down < 20) { // after 20 failures in a row our server is considered down for the rest of the run
      try { const r = await local.smart(a, b, o); if (r) return Object.assign(r, { p: PROFILE }); }
      catch (e) { /* our server failed: fall back below */ }
    }
    const r = await car.smart(a, b, o);
    return r && Object.assign(r, { p: "car", fb: 1 });
  } };
}

const rl = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on("line", line => { chain = chain.then(async () => {
  let r = null; try { const q = JSON.parse(line); r = await R.smart(q.a, q.b, { terminal: q.t }); } catch (e) { r = null; }
  process.stdout.write(JSON.stringify(r) + "\n"); }); });
