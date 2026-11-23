import unittest, datetime as dt
from pva.classify import classify

DAY = dt.date(2026, 11, 10)


def P(sidur, m, kind, mkt8):
    return dict(sidur=sidur, dep_min=m, kind=kind, mkt8=mkt8, line=None, desc='', km=1.0, real_min=None, vtype=None)


def E(i, sidur, h, mi, kind, mkt8, veh=1, nextday=False):
    s = dt.datetime(2026, 11, 11 if nextday else 10, h, mi)
    return dict(id=i, kind=kind, start=s, end=s + dt.timedelta(minutes=10), sidur=sidur, mkt8=mkt8, line=0, veh=veh)


def trips(res, sidur):
    return [s for s in res['sidurim'] if s['sidur'] == sidur][0]['trips']


class TestClassify(unittest.TestCase):
    def test_exact_match_planned(self):
        r = classify([P('1', 450, 'service', 'A')], [E(1, '1', 7, 30, 'service', 'A')], DAY)
        t = trips(r, '1'); self.assertEqual([x['status'] for x in t], ['planned'])

    def test_time_shift_changed(self):
        r = classify([P('1', 450, 'service', 'A')], [E(1, '1', 7, 50, 'service', 'A')], DAY)
        self.assertEqual(trips(r, '1')[0]['status'], 'changed')

    def test_route_not_in_sidur_added(self):
        r = classify([P('1', 450, 'service', 'A')], [E(1, '1', 7, 30, 'service', 'A'), E(2, '1', 9, 0, 'empty', 'Z')], DAY)
        t = trips(r, '1'); self.assertEqual(t[1]['status'], 'added'); self.assertEqual(t[1]['empty_kind'], 'extra')

    def test_plan_row_not_executed_not_done(self):
        r = classify([P('1', 450, 'service', 'A'), P('1', 600, 'empty', 'B'), P('2', 500, 'service', 'C')],
                     [E(1, '1', 7, 30, 'service', 'A')], DAY)
        self.assertEqual([x['status'] for x in trips(r, '1')], ['planned', 'not_done'])
        self.assertNotIn('2', [s['sidur'] for s in r['sidurim']])  # sidur not executed at all: not listed

    def test_unplanned_sidur_dispatcher(self):
        r = classify([P('1', 450, 'service', 'A')], [E(1, '85', 13, 48, 'empty', 'X')], DAY)
        t = trips(r, '85')[0]
        self.assertEqual((t['status'], t['empty_kind']), ('added', 'dispatcher')); self.assertEqual(r['unplanned_sidurim'], ['85'])

    def test_after_midnight_matches_late_plan_row(self):
        r = classify([P('1', 1530, 'empty', 'A')], [E(1, '1', 1, 30, 'empty', 'A', nextday=True)], DAY)
        self.assertEqual(trips(r, '1')[0]['status'], 'planned')

    def test_sidur_two_vehicles(self):
        r = classify([P('1', 450, 'service', 'A'), P('1', 600, 'service', 'B')],
                     [E(1, '1', 7, 30, 'service', 'A', veh=11), E(2, '1', 10, 0, 'service', 'B', veh=22)], DAY)
        self.assertEqual(len([s for s in r['sidurim'] if s['sidur'] == '1']), 1)
        self.assertEqual([x['exec']['veh'] for x in trips(r, '1')], [11, 22])


if __name__ == '__main__':
    unittest.main()
