import unittest, zipfile, tempfile, os
from pva import ends

DEPOTS = [dict(id='gs7mosk', name='מוסך גבעת שאול', lat='31.796505', lon='35.184479')]
FORCED = [dict(name='ירושלים, ת. מרכזית ירושלים/יפו', to_stop='ירושלים, היכל המשפט/אבא אבן')]
S4156 = dict(code='4156', name='ת. מרכזית ירושלים/יפו', lat=31.7886, lon=35.2026)
S1106 = dict(code='1106', name='היכל המשפט/אבא אבן', lat=31.7865, lon=35.2056)
FAR = dict(code='9', name='רחוק', lat=31.90, lon=35.30)


def gtfs_zip():
    p = os.path.join(tempfile.mkdtemp(), 'g.zip')
    with zipfile.ZipFile(p, 'w') as z:
        z.writestr('routes.txt', 'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_color\n1,25,154,x,12154-2-#,3,\n2,25,1,x,99999-1-#,3,\n3,135,139,x,16139-2-#,3,\n4,3,139,x,17139-2-#,3,\n')
        z.writestr('trips.txt', 'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id,wheelchair_accessible\n1,1,t1,h,0,1,1\n1,1,t2,h,0,1,1\n2,1,t3,h,0,1,1\n3,1,t4,h,0,1,1\n4,1,t5,h,0,1,1\n')
        z.writestr('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,shape_dist_traveled\n'
                   't1,1,1,10,1,0,0,0\nt1,1,1,11,2,0,0,0\nt1,1,1,12,3,0,0,0\nt2,1,1,10,1,0,0,0\nt2,1,1,12,2,0,0,0\nt3,1,1,11,1,0,0,0\nt4,1,1,11,1,0,0,0\nt4,1,1,10,2,0,0,0\nt5,1,1,12,1,0,0,0\nt5,1,1,12,2,0,0,0\n')
        z.writestr('stops.txt', 'stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,location_type,parent_station,zone_id\n'
                   '10,1106,היכל המשפט/אבא אבן,d,31.7865,35.2056,0,,1\n11,5,x,d,31,35,0,,1\n12,4156,ת. מרכזית ירושלים/יפו,d,31.7886,35.2026,0,,1\n')
    return p


def svc(first, last):
    return dict(kind='service', status='planned', plan=dict(mkt8='12154240', desc=''), exec=dict(mkt8='12154240'), first=first, last=last)


def emp(desc='', ek='planned'):
    return dict(kind='empty', status='planned', empty_kind=ek, plan=dict(mkt8='66000044', desc=desc), exec=dict(mkt8='66000044'))


class TestEnds(unittest.TestCase):
    def test_route_ends_from_gtfs(self):
        r = ends.route_ends(gtfs_zip(), {'12154240'})
        self.assertEqual(r['12154-2'][0]['code'], '1106'); self.assertEqual(r['12154-2'][1]['code'], '4156')
        self.assertNotIn('99999-1', r)

    def test_route_ends_by_line_and_direction_when_makat_differs(self):
        # the operator's internal makat 33139 is 16139 at the MOT; same line 139, direction 2, operator's agency only
        r = ends.route_ends(gtfs_zip(), {'33139200'}, lines={'33139200': 139}, agency='135')
        self.assertEqual((r['33139-2'][0]['code'], r['33139-2'][1]['code'], r['33139-2'][2]), ('5', '1106', 'line'))

    def test_gtfs_key(self):
        self.assertEqual(ends.gtfs_key('12154240'), '12154-2'); self.assertEqual(ends.gtfs_key('11401149'), '11401-1')

    def test_end_from_prev_service_last_stop(self):
        t = [svc(S1106, S4156), emp(), svc(S1106, S4156)]
        ends.resolve(t, DEPOTS)
        self.assertEqual((t[1]['a']['code'], t[1]['b']['code'], t[1]['end_src']), ('4156', '1106', 'gtfs'))

    def test_depot_by_name(self):
        t = [emp('מוסך גבעת שאול-היכל המשפט'), svc(S1106, S4156), emp('ת.מ./רח.יפו-מוסך גבעת שאול')]
        ends.resolve(t, DEPOTS)
        self.assertEqual(t[0]['a']['depot'], 'gs7mosk'); self.assertEqual(t[0]['b']['code'], '1106')
        self.assertEqual(t[2]['b']['depot'], 'gs7mosk'); self.assertEqual(t[2]['end_src'], 'depot')

    def test_depot_named_mid_day_wins_over_neighbour(self):
        t = [svc(S1106, S4156), emp('ת.מ./רח.יפו-מוסך גבעת שאול'), emp('מוסך גבעת שאול-היכל המשפט'), svc(S1106, S4156)]
        ends.resolve(t, DEPOTS)
        self.assertEqual((t[1]['a']['code'], t[1]['b']['depot'], t[1]['end_src']), ('4156', 'gs7mosk', 'depot'))
        self.assertEqual((t[2]['a']['depot'], t[2]['b']['code']), ('gs7mosk', '1106'))

    def test_place_learned_from_service_trips_fills_missing_neighbour(self):
        # 10.11: 'בנייני האומה-חניון ביטוח לאומי' then a dispatcher leg from Atarot; the parking is where its lines start
        PK = dict(code='7', name='תחנה תפעולית/ביטוח לאומי', lat=31.79, lon=35.20)
        day = [dict(svc(PK, S1106), desc='חניון ביטוח לאומי-רמת גבעת זאב'), dict(svc(PK, S4156), desc='חניון ביטוח לאומי - מחנה עופר')]
        places = ends.learn_places(day)
        t = [svc(S1106, S4156), emp('בנייני האומה-חניון ביטוח לאומי'), emp('מוסך גבעת שאול-היכל המשפט'), svc(S1106, S4156)]
        ends.resolve(t, DEPOTS, places=places)
        self.assertEqual((t[1]['b']['code'], t[1]['end_src']), ('7', 'gtfs'))

    def test_place_not_learned_from_one_trip_or_scattered_stops(self):
        day = [dict(svc(S1106, S4156), desc='מקום א-ב'), dict(svc(S1106, S4156), desc='מקום ב-ג'), dict(svc(FAR, S4156), desc='מקום ב-ד')]
        self.assertEqual(ends.learn_places(day), {})

    def test_unknown_end_taken_from_next_empty_start(self):
        # David 19.11 (vehicle ...8102): police/Harel -> ?, then the next leg leaves Atarot, so the first went to Atarot
        t = [svc(S1106, S4156), emp(), emp('מוסך גבעת שאול-היכל המשפט'), svc(S1106, S4156)]
        ends.resolve(t, DEPOTS)
        self.assertEqual((t[1]['b']['depot'], t[1]['end_src']), ('gs7mosk', 'inferred'))
        self.assertEqual(t[1]['inferred'], 'b')

    def test_unknown_start_taken_from_previous_empty_end(self):
        t = [emp('היכל המשפט-מוסך גבעת שאול'), emp(), svc(S1106, S4156)]
        ends.resolve(t, DEPOTS)
        self.assertEqual((t[1]['a']['depot'], t[1]['b']['code'], t[1]['end_src']), ('gs7mosk', '1106', 'inferred'))

    def test_empty_after_empty_unresolved(self):
        t = [svc(S1106, S4156), emp(), emp('א-ב'), svc(S1106, S4156)]
        ends.resolve(t, DEPOTS)  # neither leg knows the place between them
        self.assertEqual(t[1]['end_src'], 'unresolved'); self.assertEqual(t[2]['end_src'], 'unresolved')

    def test_not_done_trips_are_skipped_as_neighbours(self):
        nd = svc(FAR, FAR); nd['status'] = 'not_done'
        t = [svc(S1106, S4156), nd, emp(), svc(S1106, S4156)]
        ends.resolve(t, DEPOTS)
        self.assertEqual(t[2]['a']['code'], '4156')

    def test_forced_after_dropoff(self):
        e = dict(emp(), a=S4156, b=S1106)
        self.assertTrue(ends.is_forced(e, FORCED, DEPOTS, 5))

    def test_forced_depot_pullout_far(self):
        dep = dict(depot='gs7mosk', name='מוסך גבעת שאול', lat=31.796505, lon=35.184479)
        self.assertTrue(ends.is_forced(dict(emp(), a=dep, b=FAR, our_km=15.0), FORCED, DEPOTS, 5))
        self.assertFalse(ends.is_forced(dict(emp(), a=dep, b=S1106, our_km=2.6), FORCED, DEPOTS, 5))

    def test_dispatcher_not_forced(self):
        e = dict(emp(ek='dispatcher'), a=S4156, b=S1106)
        self.assertFalse(ends.is_forced(e, FORCED, DEPOTS, 5))


if __name__ == '__main__':
    unittest.main()
