import unittest
from pva.plausibility import label_vehicle

DEP = dict(depot='gs7mosk', name='מוסך גבעת שאול', lat=31.7965, lon=35.1845)
ATA = dict(depot='at7mosk', name='מוסך עטרות', lat=31.8575, lon=35.2189)
A = dict(code='1106', name='היכל המשפט', lat=31.7865, lon=35.2056)
B = dict(code='4156', name='ת.מ.', lat=31.7886, lon=35.2026)
M = dict(code='5', name='מבשרת', lat=31.80, lon=35.148)
FAR = dict(code='9', name='רחוק', lat=31.90, lon=35.30)


def S(t0, a, b):
    return dict(kind='service', t0=t0, a=a, b=b, empty_kind=None, status='planned')


def E(t0, a, b, ek='dispatcher'):
    return dict(kind='empty', t0=t0, a=a, b=b, empty_kind=ek, status='added' if ek == 'dispatcher' else 'planned')


class TestPlausibility(unittest.TestCase):
    def test_explained_relocation_into_service(self):
        L = [E(300, ATA, M), S(320, M, A)]
        label_vehicle(L); self.assertEqual(L[0]['plaus'], 'explained')

    def test_explained_into_depot_then_out(self):
        L = [S(300, A, B), E(400, B, ATA), E(500, ATA, M, 'planned'), S(520, M, A)]
        label_vehicle(L); self.assertEqual(L[1]['plaus'], 'explained')

    def test_end_of_day_to_depot(self):
        L = [S(300, A, B), E(400, B, DEP)]
        label_vehicle(L); self.assertEqual(L[1]['plaus'], 'end_of_day')

    def test_end_of_day_not_depot_review(self):
        L = [S(300, A, B), E(400, B, M)]
        label_vehicle(L); self.assertEqual(L[1]['plaus'], 'end_of_day_review')

    def test_round_trip(self):
        L = [S(300, A, B), E(400, B, M), E(450, M, B, 'planned'), S(500, B, A)]
        label_vehicle(L); self.assertEqual(L[1]['plaus'], 'round_trip')

    def test_round_trip_via_depot(self):
        L = [S(300, A, B), E(400, B, DEP), E(450, DEP, A, 'planned'), S(500, A, B)]
        label_vehicle(L); self.assertEqual(L[1]['plaus'], 'via_depot')

    def test_inconsistent_next_starts_elsewhere(self):
        L = [E(300, ATA, M), S(320, FAR, A)]
        label_vehicle(L); self.assertEqual(L[0]['plaus'], 'inconsistent')

    def test_unknown_ends(self):
        L = [E(300, None, None), S(320, M, A)]
        label_vehicle(L); self.assertEqual(L[0]['plaus'], 'unknown')

    def test_unknown_end_before_dispatcher_leg_ignored(self):
        # 10.11 vehicle ...302: a planned leg to an unknown parking, then the dispatcher moves the bus Atarot -> Givat Shaul
        L = [S(300, A, B), E(389, B, None, 'planned'), E(793, ATA, DEP), S(810, DEP, A)]
        label_vehicle(L); self.assertEqual(L[2]['plaus'], 'explained')

    def test_inconsistent_says_why(self):
        # David 19.11 (sidur 28): the leg ends at Atarot, the next service leaves from elsewhere, nothing recorded between
        L = [E(880, M, ATA), S(1050, FAR, A)]
        label_vehicle(L)
        self.assertIn('מוסך עטרות', L[0]['plaus_why']); self.assertIn('17:30', L[0]['plaus_why']); self.assertIn('רחוק', L[0]['plaus_why'])

    def test_estimated_end_is_not_explained(self):
        # David 19.11 (sidur 115): an end the report does not give stays an estimate; a bus may leave from another place
        L = [S(300, A, B), dict(E(400, B, ATA), inferred='b'), E(420, ATA, M), S(450, M, A)]
        label_vehicle(L)
        self.assertEqual(L[1]['plaus'], 'estimated'); self.assertIn('לא נכתב בדוח', L[1]['plaus_why'])

    def test_only_dispatcher_trips_labelled(self):
        L = [S(300, A, B), E(400, B, A, 'planned'), S(420, A, B)]
        label_vehicle(L); self.assertNotIn('plaus', L[1])


if __name__ == '__main__':
    unittest.main()
