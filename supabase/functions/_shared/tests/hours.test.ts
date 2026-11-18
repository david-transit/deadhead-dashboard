import { test } from "node:test";
import assert from "node:assert/strict";
import { businessMs } from "../hours.ts";

const H = { days: [0, 1, 2, 3, 4], from: "08:00", to: "17:00" };
const h = (n: number) => n * 3600_000;

test("Thursday 16:00 to Sunday 09:00 Israel time = 2 business hours", () => {
  // 19.11.2026 is a Thursday; Israel is UTC+2 in November
  assert.equal(businessMs(new Date("2026-11-19T14:00:00Z"), new Date("2026-11-22T07:00:00Z"), H), h(2));
});
test("inside one day, 09:00-12:00 = 3 hours", () => {
  assert.equal(businessMs(new Date("2026-11-18T07:00:00Z"), new Date("2026-11-18T10:00:00Z"), H), h(3));
});
test("across the switch to winter time (25.10.2026): local hours, no one-hour drift", () => {
  // Thu 22.10 16:00 local (UTC+3) -> Sun 25.10 09:00 local (UTC+2)
  assert.equal(businessMs(new Date("2026-10-22T13:00:00Z"), new Date("2026-10-25T07:00:00Z"), H), h(2));
});
test("to before from = 0", () => {
  assert.equal(businessMs(new Date("2026-11-18T10:00:00Z"), new Date("2026-11-18T07:00:00Z"), H), 0);
});
