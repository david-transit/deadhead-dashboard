import unittest
from pva.lessons import lessons

S4156 = dict(code='4156', name='ת. מרכזית ירושלים/יפו', lat=31.7886, lon=35.2026)
S1106 = dict(code='1106', name='היכל המשפט/אבא אבן', lat=31.7865, lon=35.2056)
BL = [31.7834, 35.2031]  # ביטוח לאומי, ~360 m from 1106


def pva(trips):
    return dict(day='2026-11-10', sidurim=[dict(sidur='1', in_plan=True, trips=trips)])


def T(kind, t0, a=None, b=None, ek=None, status='planned', veh=5, verdict=None, desc=''):
    return dict(kind=kind, t0=t0, a=a, b=b, empty_kind=ek, status=status, veh=veh, verdict=verdict, desc=desc, sidur='1',
                op_km=1.2, our_km=1.7)


def ours(items):
    return dict(day='2026-11-10', vehicles=[dict(veh=5, items=items)])


class TestLessons(unittest.TestCase):
    def test_lesson_wrong_next_stop(self):
        p = pva([T('service', 450, S1106, S4156), T('empty', 500, S4156, S1106, 'planned'), T('service', 510, S1106, S4156)])
        o = ours([dict(kind='trip', start=450, end=495), dict(kind='empty', start=495, end=510, a=[S4156['lat'], S4156['lon']], b=BL,
                                                              frm='ירושלים, ת. מרכזית ירושלים/יפו', to='ירושלים, תחנה תפעולית/ביטוח לאומי'),
                  dict(kind='trip', start=510, end=560)])
        L = {x['type']: x for x in lessons(o, p)}
        self.assertEqual(L['other_destination']['count'], 1)
        self.assertIn('ביטוח לאומי', L['other_destination']['examples'][0]['ours'])

    def test_lesson_missing_dispatcher_leg(self):
        p = pva([T('service', 450, S1106, S4156), T('empty', 600, S4156, S1106, 'dispatcher', 'added'), T('service', 700, S1106, S4156)])
        o = ours([dict(kind='trip', start=450, end=495), dict(kind='trip', start=700, end=760)])
        L = {x['type']: x for x in lessons(o, p)}
        self.assertEqual(L['missing_in_ours']['count'], 1)

    def test_km_gap_lesson_counts_verdicts(self):
        p = pva([T('empty', 500, S4156, S1106, 'planned', verdict='op', desc='ת.מ./רח.יפו-היכל המשפט')])
        L = {x['type']: x for x in lessons(ours([]), p)}
        self.assertEqual(L['km_gap']['by_verdict'], {'op': 1})


if __name__ == '__main__':
    unittest.main()


class TestChains(unittest.TestCase):
    def test_via_depot_chain(self):
        dep = dict(depot='gs7mosk', name='מוסך גבעת שאול', lat=31.7965, lon=35.1845)
        p = pva([T('service', 450, S1106, S4156), T('empty', 500, S4156, dep, 'planned'), T('empty', 560, dep, S1106, 'planned'),
                 T('service', 600, S1106, S4156)])
        o = ours([dict(kind='trip', start=450, end=495), dict(kind='empty', start=495, end=600, a=[S4156['lat'], S4156['lon']],
                                                              b=[S1106['lat'], S1106['lon']], frm='x', to='y'), dict(kind='trip', start=600, end=650)])
        L = {x['type']: x for x in lessons(o, p)}
        self.assertEqual((L['via_stop']['count'], L['other_destination']['count'], L['missing_in_ours']['count']), (1, 0, 0))
        self.assertIn('מוסך גבעת שאול', L['via_stop']['examples'][0]['via'])
