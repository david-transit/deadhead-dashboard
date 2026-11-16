// Batch road routing for the pipeline: one JSON request per stdin line {a:[lat,lon], b:[lat,lon], t:[bool,bool]},
// one JSON answer per stdout line (assets/route.js smart(); null when OSRM has no route / is unavailable).
const path = require("path"), readline = require("readline");
const R = require(path.join(__dirname, "..", "assets", "route.js")).make();
const rl = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on("line", line => { chain = chain.then(async () => {
  let r = null; try { const q = JSON.parse(line); r = await R.smart(q.a, q.b, { terminal: q.t }); } catch (e) { r = null; }
  process.stdout.write(JSON.stringify(r) + "\n"); }); });
