import unittest, datetime as dt
from pva import read
from pva.tests.fixtures import plan_xlsx, exec_xlsx, D


class TestRead(unittest.TestCase):
    def test_hmm_past_midnight(self):
        self.assertEqual(read.hmm_to_min(2911), 1751)
        self.assertEqual(read.hmm_to_min(730), 450)

    def test_service_day_after_midnight(self):
        self.assertEqual(read.service_day(D(2026, 11, 11, 2, 30)), dt.date(2026, 11, 10))
        self.assertEqual(read.service_day(D(2026, 11, 11, 4, 0)), dt.date(2026, 11, 11))

    def test_day_type(self):
        self.assertEqual(read.day_type(dt.date(2026, 11, 13)), 'fri')
        self.assertEqual(read.day_type(dt.date(2026, 11, 14)), 'sat')
        self.assertEqual(read.day_type(dt.date(2026, 11, 10)), 'weekday')

    def test_plan_rows(self):
        p = plan_xlsx([dict(sidur=52001, t=2911, kind='ריקה', mkt8=65982244, desc='א-ב', km=4.4, real=10),
                       dict(sidur=52001, t=730, kind='שרות', mkt8=15404240, line=404, km=63.5, vtype='עירוני עליה חופשית')])
        r = read.read_plan(p)
        self.assertEqual(r[0], dict(sidur='52001', dep_min=1751, kind='empty', mkt8='65982244', line=None, desc='א-ב',
                                    km=4.4, real_min=10, vtype=None))
        self.assertEqual(r[1]['kind'], 'service'); self.assertEqual(r[1]['line'], 404)

    def test_names_not_kept(self):
        p = exec_xlsx([dict(id=1, kind='ריקה', start=D(2026, 11, 10, 6), end=D(2026, 11, 10, 6, 10), sidur=85,
                            mkt8=66708144, veh=90000001, driver=99001, first='יוסי', last='כהן')])
        r = read.read_exec(p)
        self.assertEqual(set(r[0]), {'id', 'kind', 'start', 'end', 'sidur', 'mkt8', 'line', 'veh', 'driver'})
        self.assertNotIn('יוסי', repr(r)); self.assertNotIn('כהן', repr(r))
        self.assertEqual(r[0]['kind'], 'empty'); self.assertEqual(r[0]['driver'], '99001'); self.assertEqual(r[0]['sidur'], '85')

    def test_missing_driver_code(self):
        p = exec_xlsx([dict(id=2, kind='שירות', start=D(2026, 11, 10, 7), end=D(2026, 11, 10, 8), sidur=52001,
                            mkt8=15404240, line=404, veh=1, driver=None)])
        self.assertIsNone(read.read_exec(p)[0]['driver'])

    def test_urban_filter(self):
        rows = [dict(sidur='1', kind='service', vtype='בין-עירוני'), dict(sidur='1', kind='empty', vtype=None),
                dict(sidur='2', kind='service', vtype='עירוני עליה חופשית')]
        self.assertEqual(read.urban_sidurim(rows), {'2'})


if __name__ == '__main__':
    unittest.main()
