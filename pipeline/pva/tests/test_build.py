import unittest, json, os, shutil, tempfile, datetime as dt
from pva import build
from pva.tests.fixtures import plan_xlsx, exec_xlsx, D
from pva.tests.test_ends import gtfs_zip

DEPOTS = [dict(id='gs7mosk', name='מוסך גבעת שאול', lat='31.796505', lon='35.184479')]
CFG = dict(gap_km=0.3, gap_pct=10, google_tol_km=0.3, depot_alias={})


def src_dir():
    d = tempfile.mkdtemp()
    shutil.copy(plan_xlsx([
        dict(sidur=1, t=700, kind='ריקה', mkt8=66196844, desc='מוסך גבעת שאול-היכל המשפט', km=2.6),
        dict(sidur=1, t=715, kind='שרות', mkt8=12154240, line=154, km=14.6, vtype='עירוני עליה חופשית'),
        dict(sidur=1, t=900, kind='ריקה', mkt8=66292044, desc='ת.מ./רח.יפו-היכל המשפט', km=1.2),
        dict(sidur=1, t=915, kind='שרות', mkt8=12154240, line=154, km=14.6, vtype='עירוני עליה חופשית'),
        dict(sidur=9, t=800, kind='שרות', mkt8=12154240, line=154, km=14.6, vtype='בין-עירוני')]),
        os.path.join(d, 'כותרות + נסיעות - מפת בסיס א-ה.xlsx'))
    shutil.copy(exec_xlsx([
        dict(id=1, kind='ריקה', start=D(2026, 11, 10, 7, 0), end=D(2026, 11, 10, 7, 10), sidur=1, mkt8=66196844, veh=5, driver=99001),
        dict(id=2, kind='שירות', start=D(2026, 11, 10, 7, 15), end=D(2026, 11, 10, 8, 0), sidur=1, mkt8=12154240, line=154, veh=5, driver=99001),
        dict(id=3, kind='ריקה', start=D(2026, 11, 10, 8, 5), end=D(2026, 11, 10, 8, 30), sidur=85, mkt8=66708144, veh=5, driver=99001,
             first='יוסי', last='כהן'),
        dict(id=4, kind='שירות', start=D(2026, 11, 10, 9, 15), end=D(2026, 11, 10, 10, 0), sidur=1, mkt8=12154240, line=154, veh=5, driver=None)]),
        os.path.join(d, 'דוח ביצוע.xlsx'))
    return d


def road(p, q, term=(True, True)):
    return (5.0, 10.0, {})


class TestBuild(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = build.Source(src_dir())
        cls.p = build.build_day(cls.src, dt.date(2026, 11, 10), DEPOTS, [], 5, gtfs_zip(), road, {}, CFG)

    def test_payload_has_no_names(self):
        s = json.dumps(self.p, ensure_ascii=False)
        self.assertNotIn('יוסי', s); self.assertNotIn('כהן', s)

    def test_driver_excess_sum(self):
        d = self.p['drivers']['99001']
        self.assertEqual((d['excess_km'], d['dispatcher_km']), (5.0, 5.0))  # sidur 85 is not in the plan; op km unknown -> ours

    def test_missing_driver_code_kept(self):
        self.assertIn('?', self.p['drivers'])

    def test_intercity_sidur_excluded(self):
        self.assertNotIn('9', [s['sidur'] for s in self.p['sidurim']])

    def test_not_done_listed(self):
        st = [t['status'] for s in self.p['sidurim'] if s['sidur'] == '1' for t in s['trips']]
        self.assertEqual(st.count('not_done'), 1)

    def test_trip_fields(self):
        t = next(t for s in self.p['sidurim'] for t in s['trips'] if t.get('empty_kind') == 'dispatcher')
        for k in ('veh', 'sidur', 'status', 'kind', 'empty_kind', 't0', 't1', 'a', 'b', 'op_km', 'our_km', 'g_km', 'verdict', 'km_src', 'end_src', 'driver'):
            self.assertIn(k, t)
        self.assertEqual(t['a']['code'], '4156')  # previous service of the same vehicle (other sidur) ended at 4156

    def test_dispatcher_leg_labelled(self):
        t = next(t for s in self.p['sidurim'] for t in s['trips'] if t.get('empty_kind') == 'dispatcher')
        self.assertEqual(t['plaus'], 'explained')

    def test_sql_upsert(self):
        sql = build.upsert_sql('op-uuid', self.p)
        self.assertIn("insert into private.pva_day", sql); self.assertIn("on conflict (operator_id, day) do update", sql)


if __name__ == '__main__':
    unittest.main()


class TestSecondSidurOnSameVehicle(unittest.TestCase):
    def test_vehicle_pass_ends_kept_for_executed_empty(self):
        d = tempfile.mkdtemp()
        shutil.copy(plan_xlsx([
            dict(sidur=1, t=715, kind='שרות', mkt8=12154240, line=154, km=14.6, vtype='עירוני עליה חופשית'),
            dict(sidur=2, t=900, kind='ריקה', mkt8=66292044, desc='ת.מ./רח.יפו-היכל המשפט', km=1.2),
            dict(sidur=2, t=915, kind='שרות', mkt8=12154240, line=154, km=14.6, vtype='עירוני עליה חופשית')]),
            os.path.join(d, 'כותרות + נסיעות - מפת בסיס א-ה.xlsx'))
        shutil.copy(exec_xlsx([
            dict(id=1, kind='שירות', start=D(2026, 11, 10, 7, 15), end=D(2026, 11, 10, 8, 0), sidur=1, mkt8=12154240, line=154, veh=5, driver=99001),
            dict(id=2, kind='ריקה', start=D(2026, 11, 10, 9, 0), end=D(2026, 11, 10, 9, 10), sidur=2, mkt8=66292044, veh=5, driver=99002),
            dict(id=3, kind='שירות', start=D(2026, 11, 10, 9, 15), end=D(2026, 11, 10, 10, 0), sidur=2, mkt8=12154240, line=154, veh=5, driver=99002)]),
            os.path.join(d, 'דוח ביצוע.xlsx'))
        p = build.build_day(build.Source(d), dt.date(2026, 11, 10), DEPOTS, [], 5, gtfs_zip(), road, {}, CFG)
        e = next(t for s in p['sidurim'] for t in s['trips'] if t['kind'] == 'empty')
        self.assertEqual((e['end_src'], e['a']['code'], e['b']['code']), ('gtfs', '4156', '1106'))


class TestGeometry(unittest.TestCase):
    def test_added_leg_carries_drawn_road_and_its_km(self):
        def r(p, q, term=(True, True)):
            return (5.0, 10.0, {})
        r.geom = lambda p, q: [5.12, [[31.78861, 35.20259], [31.79, 35.21], [31.78651, 35.20556]]]
        p = build.build_day(build.Source(src_dir()), dt.date(2026, 11, 10), DEPOTS, [], 5, gtfs_zip(), r, {}, CFG)
        t = next(t for s in p['sidurim'] for t in s['trips'] if t.get('empty_kind') == 'dispatcher')
        self.assertEqual((t['our_km'], len(t['geom'])), (5.12, 3))
        planned = next(t for s in p['sidurim'] for t in s['trips'] if t['kind'] == 'empty' and t['status'] == 'planned')
        self.assertIsNone(planned.get('geom'))


class TestThin(unittest.TestCase):
    def test_thin_keeps_ends_and_drops_dense_points(self):
        pts = [[31.78, 35.20 + i * 0.00001] for i in range(101)]  # ~1 m apart, ~95 m long
        out = build.thin(pts, 15)
        self.assertEqual((out[0], out[-1]), (pts[0], pts[-1])); self.assertLess(len(out), 12)
