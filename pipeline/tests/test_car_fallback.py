"""ADR-0009 item 10: the public car-OSRM fallback (fb) is marked, in no km sum.
Run: python -m unittest discover pipeline/tests"""
import os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import build_day as B


class TestCarFallback(unittest.TestCase):
    def test_bus_leg_counts(self):
        self.assertTrue(B.counts_km({"kind": "empty", "km": 12}))

    def test_car_estimate_not_counted(self):
        self.assertFalse(B.counts_km({"kind": "empty", "km": 30, "fb": 1}))

    def test_overlap_not_counted(self):
        self.assertFalse(B.counts_km({"kind": "empty", "km": 0, "overlap": True}))

    def test_vehicle_sum_excludes_fallback(self):
        items = [{"kind": "empty", "km": 12}, {"kind": "empty", "km": 30, "fb": 1}, {"kind": "trip", "km": 20}]
        self.assertEqual(round(sum(i["km"] for i in items if i["kind"] == "empty" and B.counts_km(i)), 1), 12)


if __name__ == "__main__":
    unittest.main()
