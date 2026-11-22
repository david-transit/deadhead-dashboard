import os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import gps_verify as G

# a straight road north along lon 35.20: one point a minute, 0.5 km apart, with SIRI distance along the journey
LAT0, STEP = 31.78, 0.5 / 111.2


def trace(n=12, t0=8 * 60, dist=True, start_m=0, lat0=LAT0):
    return [[f"2026-11-17T{(t0 + k) // 60:02d}:{(t0 + k) % 60:02d}:00+02:00", lat0 + k * STEP, 35.20, (start_m + k * 500) if dist else None]
            for k in range(n)]


class TestGpsVerify(unittest.TestCase):
    def test_passage_by_journey_distance(self):
        a, b = (LAT0 + 2 * STEP, 35.20), (LAT0 + 8 * STEP, 35.20)  # exactly on points 2 and 8: 3 km apart
        self.assertEqual(G.passes({"r1": trace()}, a, b), [3.0])

    def test_offsets_between_points(self):
        a, b = (LAT0 + 2.4 * STEP, 35.20), (LAT0 + 7.6 * STEP, 35.20)  # 2.6 km, ends between GPS points
        km = G.passes({"r1": trace()}, a, b)[0]
        self.assertAlmostEqual(km, 2.6, delta=0.05)

    def test_without_journey_distance_sums_steps(self):
        a, b = (LAT0 + 1 * STEP, 35.20), (LAT0 + 5 * STEP, 35.20)
        self.assertAlmostEqual(G.passes({"r1": trace(dist=False)}, a, b)[0], 2.0, delta=0.02)

    def test_opposite_direction_not_counted(self):
        a, b = (LAT0 + 8 * STEP, 35.20), (LAT0 + 2 * STEP, 35.20)  # B before A on this bus's way
        self.assertEqual(G.passes({"r1": trace()}, a, b), [])

    def test_too_far_from_the_road(self):
        a, b = (LAT0 + 2 * STEP, 35.21), (LAT0 + 8 * STEP, 35.21)  # ~0.95 km east of the road
        self.assertEqual(G.passes({"r1": trace()}, a, b), [])

    def test_verify_close_and_gap(self):
        a, b = (LAT0 + 2 * STEP, 35.20), (LAT0 + 8 * STEP, 35.20)
        tr = {"r1": trace(), "r2": trace(t0=9 * 60), "r3": trace(t0=10 * 60)}
        self.assertEqual(G.verify(tr, a, b, 3.3), [3.0, 3, True])     # 0.3 km: within 0.5 km
        self.assertEqual(G.verify(tr, a, b, 5.8), [3.0, 3, False])    # ours 5.8 vs 3.0 in practice: gap
        self.assertIsNone(G.verify({}, a, b, 3.0))                    # no bus drove it: manual check

    def test_time_window(self):
        a, b = (LAT0 + 2 * STEP, 35.20), (LAT0 + 8 * STEP, 35.20)
        cfg = dict(G.DEF, max_min=3)  # the bus needs 6 minutes from A to B
        self.assertEqual(G.passes({"r1": trace()}, a, b, cfg), [])


if __name__ == "__main__":
    unittest.main()
