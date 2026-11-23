"""Night rides Stride left unlinked (21.11.2026, David 22.11): times from the GPS points, link by trip number, no 30-minute default.
Run: python -m unittest discover pipeline/tests"""
import os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import build_day as B


def pt(hhmm_utc, lat, lon, dist, day="2026-11-21"):
    h, m = hhmm_utc
    return [f"{day}T{h:02d}:{m:02d}:00+00:00", lat, lon, dist, None, None]


class TestGpsSpan(unittest.TestCase):
    def ride(self):
        # waits at the first stop 23:10-23:16, drives 23:17-00:09 (one point a minute), waits at the last stop 00:09-01:09,
        # then moves 1.2 km (to park) - like ride 154499356 (vehicle 23405102, line 404)
        p = [pt((23, m), 31.8083, 35.2045, 0) for m in range(10, 17)]
        for k in range(53):
            m = 17 + k
            p.append(pt(((23 + m // 60) % 24, m % 60), 31.8083 + k * 0.0055, 35.2045 - k * 0.007, k * 1200,
                        day="2026-11-21" if m < 60 else "2026-11-22"))
        last = p[-1]
        for m in range(10, 70, 3):
            p.append(pt((0 + m // 60, m % 60), last[1], last[2], last[3], day="2026-11-22"))
        p.append(pt((1, 10), last[1] + 0.001, last[2] + 0.011, last[3] + 1200, day="2026-11-22"))
        return p

    def test_departure_is_when_it_starts_moving(self):
        a, b = B.gps_span(self.ride())
        self.assertEqual(a[0], "2026-11-21T23:17:00+00:00")  # the last point at the stop

    def test_arrival_is_the_stop_at_the_end_not_the_last_point(self):
        a, b = B.gps_span(self.ride())
        self.assertTrue(b[0].startswith("2026-11-22T00:09"), b[0])

    def test_never_moved_is_none(self):
        self.assertIsNone(B.gps_span([pt((23, m), 31.8, 35.2, 0) for m in range(10, 40)]))

    def test_invalid_positions_ignored(self):
        self.assertIsNone(B.gps_span([pt((23, 10), -1, -1, 0), pt((23, 40), -1, -1, 5000)]))


class TestOwnGtfsTripNumber(unittest.TestCase):
    def setUp(self):
        B.OP = {"slug": "t", "operator_ref": 135}; B.DAY_START_H = 4; B.CACHE_DIR = "."
        self.orig = B.fetch_gtfs_rides
        g21 = [dict(id=1, journey_ref="586012733_201126", start_time="2026-11-21T18:45:00+00:00", end_time="2026-11-21T20:21:00+00:00",
                    line_ref=39904, route_id=9961483, mkt="15404", dir="2", alt="1", short="404"),
               dict(id=2, journey_ref="586012734_201126", start_time="2026-11-21T21:45:00+00:00", end_time="2026-11-21T22:45:00+00:00",
                    line_ref=39904, route_id=9961483, mkt="15404", dir="2", alt="1", short="404")]
        g22 = [dict(id=9, journey_ref="586012489_211126", start_time=None, end_time=None, line_ref=39904, route_id=9967634,
                    mkt="15404", dir="2", alt="1", short="404")]
        B.fetch_gtfs_rides = lambda d, op, cf: g21 if d == "2026-11-21" else g22

    def tearDown(self):
        B.fetch_gtfs_rides = self.orig

    def raw(self, **kw):
        r = dict(id=154499356, vehicle_ref="23405102", scheduled_start_time="2026-11-21T23:15:00+00:00", journey_ref="2026-11-22-586012489",
                 siri_route__line_ref=39904, gtfs_ride_id=None, gtfs_ride__journey_ref=None, gtfs_ride__start_time=None,
                 first_vehicle_location_id=None)
        r.update(kw); return r

    def test_linked_by_trip_number_with_the_line_planned_minutes(self):
        r = self.raw()
        n = B.own_gtfs([r], "2026-11-21", {})
        self.assertEqual(n.get("by_trip_number"), 1)
        self.assertEqual((r["gtfs_ride_id"], r["own_gtfs"]), (9, "trip_no"))
        self.assertEqual(r["gtfs_ride__start_time"], "2026-11-21T23:15:00+00:00")
        self.assertEqual(B.LINE_DUR[39904], 78)  # median of 96 and 60 minutes
        self.assertTrue(r["gtfs_ride__end_time"].startswith("2026-11-22T00:33"))

    def test_other_line_or_date_not_linked(self):
        r1, r2 = self.raw(siri_route__line_ref=39903), self.raw(id=2, vehicle_ref="x", journey_ref="2026-11-23-586012489")
        B.own_gtfs([r1, r2], "2026-11-21", {})
        self.assertIsNone(r1["gtfs_ride_id"]); self.assertIsNone(r2["gtfs_ride_id"])

    def test_licensed_by_time_marked_added(self):
        r = self.raw(id=5, vehicle_ref="y", scheduled_start_time="2026-11-21T18:45:00+00:00", journey_ref="2026-11-21-586012733")
        B.own_gtfs([r], "2026-11-21", {})
        self.assertEqual((r["gtfs_ride_id"], r["own_gtfs"]), (1, "added"))


if __name__ == "__main__":
    unittest.main()
