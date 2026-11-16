/* Web Worker: runs the savings engine off the main thread.
 * in : {id, cmd:"run", day, others, ruleset, road:[[key,km,min],...], branches:{veh:name}, depots:{veh:[lat,lon]}, dcp:[...], only?, pair?, limits?}
 * out: {id, ok:true, result} | {id, ok:false, error}
 * Day data arrives already decrypted from the page and never leaves this worker except as the result. */
/* global importScripts, SavingsEngine */
importScripts("engine.js");
self.onmessage = e => {
  const m = e.data || {};
  try {
    if (m.cmd !== "run") throw new Error("פקודה לא מוכרת");
    const road = new Map((m.road || []).map(r => [r[0], { km: r[1], min: r[2] }]));
    const branches = m.branches || {}, depots = m.depots || {};
    const result = SavingsEngine.run({
      day: m.day, others: m.others || [], ruleset: m.ruleset,
      road: (a, b) => road.get(SavingsEngine.roadKey(a, b)) || null,
      branchOf: v => branches[v] || "", depotOf: v => depots[v] || null,
      dcp: m.dcp || [], only: m.only, pair: m.pair, limits: m.limits,
    });
    self.postMessage({ id: m.id, ok: true, result });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
  }
};
