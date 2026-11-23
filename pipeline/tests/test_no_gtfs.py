"""R48: a day is computed only with the MOT GTFS of that same day. No fallback to another day's or the current MOT file;
a day without it is marked "אין GTFS של היום" (data/<slug>/nogtfs.json and days.js) and not computed.
Run: python -m unittest discover pipeline/tests"""
import json, os, re, shutil, sys, tempfile, unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import build_day as B

DAY = "2026-11-24"
WF = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".github", "workflows", "nightly.yml")


class TestNoDayGtfs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cache, self.data = os.path.join(self.tmp, "cache"), os.path.join(self.tmp, "data", "op")
        os.makedirs(self.cache); os.makedirs(self.data)
        self.p = [mock.patch.object(B, "CACHE_DIR", self.cache), mock.patch.object(B, "DATA", self.data),
                  mock.patch.object(B, "OP", {"slug": "op", "name": "מפעיל"}), mock.patch.object(B, "DAY_START_H", 4)]
        for x in self.p: x.start()

    def tearDown(self):
        for x in self.p: x.stop()
        shutil.rmtree(self.tmp)

    def days_meta(self):
        t = open(os.path.join(self.data, "days.js"), encoding="utf-8").read()
        return json.loads(re.match(r'^\(window\.OPDAYS=window\.OPDAYS\|\|\{\}\)\["op"\]=(\{.*\});\s*$', t, re.S).group(1))

    def test_build_refuses_without_the_days_gtfs(self):
        # the "latest" file (another day / today's MOT file) is there, the day's own is not: no build, nothing fetched
        open(os.path.join(self.cache, "gtfs_shapes_op.json"), "w").write("{}")
        open(os.path.join(self.cache, "gtfs_shapes_op_2026-11-23.json"), "w").write("{}")
        with mock.patch.object(B, "fetch_rides", side_effect=AssertionError("fetched")):
            with self.assertRaises(B.NoDayGtfs) as e:
                B.build(DAY)
        self.assertIn(B.NO_GTFS, str(e.exception.code))

    def test_days_own_file_is_used(self):
        f = os.path.join(self.cache, f"gtfs_shapes_op_{DAY}.json"); open(f, "w").write("{}")
        self.assertEqual(B.day_shapes_file(DAY), f)

    def test_mark_lists_the_day_not_computed(self):
        B.mark_no_gtfs(DAY)
        self.assertEqual(B.nogtfs_days(), {DAY: B.NO_GTFS})
        m = self.days_meta()
        self.assertEqual(m["nogtfs"], [DAY])
        self.assertNotIn(DAY, m["days"])
        self.assertFalse(os.path.exists(os.path.join(self.data, f"day_{DAY}.js")))

    def test_built_later_clears_the_mark(self):
        B.mark_no_gtfs(DAY)
        open(os.path.join(self.data, f"day_{DAY}.js"), "w").write("x")  # the archive came later and the day was built
        B.set_nogtfs(DAY, False); B.write_days_index()
        m = self.days_meta()
        self.assertEqual(m["nogtfs"], []); self.assertIn(DAY, m["days"])
        self.assertFalse(os.path.exists(B.nogtfs_path()))

    def test_built_day_is_never_marked(self):
        open(os.path.join(self.data, f"day_{DAY}.js"), "w").write("x")
        B.mark_no_gtfs(DAY)
        self.assertEqual(B.nogtfs_days(), {})

    def test_nightly_has_no_fallback_to_the_current_mot_file(self):
        wf = open(WF, encoding="utf-8").read()
        self.assertNotIn("gtfs.mot.gov.il", wf)
        self.assertIn("--no-gtfs", wf)


if __name__ == "__main__":
    unittest.main()
