"""Operator files in private Storage (David 22.11, stage 2): what moves, and the public hash list.
Run: python -m unittest discover pipeline/tests"""
import json, os, sys, tempfile, unittest, hashlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import storage_sync as S


class TestStorageSync(unittest.TestCase):
    def test_pull_only_missing_or_changed(self):
        rem = {'day_2026-11-20.js': 'a', 'day_2026-11-21.js': 'b', 'days.js': 'c'}
        loc = {'day_2026-11-20.js': 'a', 'days.js': 'old'}
        self.assertEqual(S.plan_pull(rem, loc), ['day_2026-11-21.js', 'days.js'])

    def test_push_only_new_or_changed(self):
        rem = {'day_2026-11-20.js': 'a', 'days.js': 'c'}
        loc = {'day_2026-11-20.js': 'a', 'day_2026-11-21.js': 'b', 'days.js': 'c2'}
        self.assertEqual(S.plan_push(rem, loc), ['day_2026-11-21.js', 'days.js'])

    def test_nothing_moves_when_in_sync(self):
        same = {'day_2026-11-20.js': 'a', 'ends_2026-11.js': 'e', 'days.js': 'c'}
        self.assertEqual(S.plan_pull(same, dict(same)), [])
        self.assertEqual(S.plan_push(same, dict(same)), [])

    def test_manifest_has_only_day_hashes(self):
        with tempfile.TemporaryDirectory() as t:
            d = os.path.join(t, 'op'); os.makedirs(d)
            for n, txt in (('day_2026-11-20.js', 'x'), ('day_2026-11-21.js', 'y\r\n'), ('days.js', 'z'), ('ends_2026-11.js', 'w')):
                open(os.path.join(d, n), 'wb').write(txt.encode())
            h = S.manifest('op', data=t)
            self.assertEqual(sorted(h), ['2026-11-20', '2026-11-21'])
            self.assertEqual(h['2026-11-21'], hashlib.sha256(b'y\n').hexdigest())   # CRLF normalised like pva.seal
            self.assertEqual(json.load(open(os.path.join(d, 'hashes.json'))), h)


if __name__ == '__main__':
    unittest.main()
