import unittest
from pva import km

CFG = dict(gap_km=0.3, gap_pct=10)


class TestKm(unittest.TestCase):
    def test_config_has_pva_thresholds(self):
        self.assertEqual(km.load_cfg(), CFG)

    def test_no_gap(self):
        self.assertEqual(km.verdict(12.4, 12.6, CFG), 'match')

    def test_gap_needs_both(self):
        self.assertEqual(km.verdict(15.0, 15.4, CFG), 'match')      # 0.4 km but 2.7%
        self.assertEqual(km.verdict(1.2, 1.6, CFG), 'third')        # 0.4 km and 33%: manual check

    def test_gap_is_manual_check(self):
        self.assertEqual(km.verdict(12.4, 14.0, CFG), 'third')   # no Google result is used (Maps terms)

    def test_route_without_operator_km(self):
        t = dict(kind='empty', plan=None, exec=dict(mkt8='66688844'), a=dict(lat=31.79, lon=35.18), b=dict(lat=31.85, lon=35.21))
        km.fill(t, {}, lambda p, q, term=(True, True): (9.1, 14.0, {}), CFG)
        self.assertEqual((t['op_km'], t['our_km'], t['km_src'], t['verdict']), (None, 9.1, 'ours', 'n/a'))

    def test_operator_km_by_route_code(self):
        t = dict(kind='empty', plan=None, exec=dict(mkt8='66708144'), a=dict(lat=31.85, lon=35.21), b=dict(lat=31.79, lon=35.18))
        km.fill(t, {'66708144': 12.4}, lambda p, q, term=(True, True): (12.9, 15.0, {}), CFG)
        self.assertEqual((t['op_km'], t['km_src'], t['verdict']), (12.4, 'op', 'match'))

    def test_unresolved_ends_no_routing(self):
        t = dict(kind='empty', plan=None, exec=dict(mkt8='1'), a=None, b=None)
        km.fill(t, {'1': 3.0}, lambda *a, **k: self.fail('routed without ends'), CFG)
        self.assertEqual((t['op_km'], t['our_km'], t['verdict']), (3.0, None, 'n/a'))


if __name__ == '__main__':
    unittest.main()

