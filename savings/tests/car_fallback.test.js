// node --test savings/tests/car_fallback.test.js
// ADR-0009 item 10: an empty leg routed by the public car OSRM (fb: 1) is "הערכת רכב, לא אוטובוס":
// marked, in no km sum, and never in a recommendation.
const test = require("node:test"), assert = require("node:assert/strict");
const DH = require("../../assets/core.js"), E = require("../engine.js");

const X = [31.80, 35.20], P = [31.90, 35.20];
const trip = (start, end, a, b) => ({ kind: "trip", start, end, sched: start, line: "1", cls: "עירוני", a, b, frm: "a", to: "b", km: 20 });
const leg = (start, end, km, fb) => Object.assign({ kind: "empty", start, end, km, drive_min: 15 }, fb ? { fb: 1 } : {});
const veh = (id, fb) => ({ veh: id, cls: "עירוני", service_km: 60, first_o: [X[0], X[1], "x"], last_d: [X[0], X[1], "x"],
  items: [trip(480, 540, X, P), leg(540, 600, 12), trip(600, 660, P, X), leg(660, 700, 30, fb), trip(700, 760, X, X)] });
const model = () => DH.Model({ days: ["2026-11-23"], dayStartMin: 240, ends: {}, S: { depots: [], vehicles: {}, defaults: {} },
  OVN: {}, REIN: {}, AUTOR: {}, road: () => null });

test("dashboard model: a car-estimate leg is counted apart, not in empty km or the vehicle's day km", () => {
  const s = model().vehicleDay(veh("A1", true), "2026-11-23");
  assert.equal(s.emp, 12);
  assert.equal(s.car, 30);
  assert.equal(s.day, 60 + 12);
  const n = model().vehicleDay(veh("B1", false), "2026-11-23");   // same vehicle without the fallback: all counted
  assert.equal(n.emp, 42); assert.equal(n.car, 0);
});

test("savings engine: a vehicle with a car-estimate leg is left out of every recommendation", () => {
  const day = { day: "2026-11-23", day_start_min: 240, routes: [], vehicles: [veh("A1", true), veh("B1", false)] };
  const b = E.getBlocks(day);
  assert.deepEqual(b.vehicles.map(v => v.veh), ["B1"]);
  const why = JSON.stringify(b);
  assert.match(why, /הערכת רכב, לא אוטובוס/);
});
