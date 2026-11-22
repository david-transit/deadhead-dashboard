import os, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tools"))
import google_yesno as G


def leg(km, a=(31.80, 35.20), b=(31.801, 35.201), gv=None, rt=None):
    return dict(kind="empty", km=km, a=list(a), b=list(b), frm="x", to="y", **({"gv": gv} if gv else {}), **({"rt": rt} if rt else {}))


class TestGoogleYesNo(unittest.TestCase):
    def test_close_rule(self):
        self.assertTrue(G.close(5.9, 5.84))      # 0.06 km
        self.assertTrue(G.close(10.0, 11.4))     # 1.4 km but < 15 % of 11.4
        self.assertFalse(G.close(2.66, 4.26))    # 1.6 km and 38 %
        self.assertTrue(G.close(1.2, 0.8))       # 0.4 km: within 0.5 km

    def test_only_legs_without_gps(self):
        day = {"vehicles": [{"veh": "1", "items": [leg(5.8), leg(5.8, a=(31.81, 35.21), gv=[5.7, 3]), leg(0.5)]}]}
        P = G.pairs_without_gps([day], {})
        self.assertEqual(len(P), 1)              # the GPS one is decided by GPS; the 0.5 km one has no warning
        self.assertEqual(list(P.values())[0][2], 5.8)

    def test_route_check_flag(self):
        self.assertTrue(G.flagged(leg(1.0, rt={"s": [40, 0]})))
        self.assertFalse(G.flagged(leg(1.0, rt={"s": [5, 0]})))

    def test_nothing_from_google_is_kept(self):
        fake = lambda url, body, headers, method: {"routes": [{"distanceMeters": 5890, "duration": "660s", "polyline": {"encodedPolyline": "abc"}}]}
        ok = G.google_close("k", [31.8, 35.2], [31.9, 35.3], 5.84, post=fake)
        self.assertIs(ok, True)
        r = G.row([31.8, 35.2], [31.9, 35.3], 5.84, ok, "2026-11-22T10:00:00+00:00")
        self.assertEqual(set(r), {"a_lat", "a_lon", "b_lat", "b_lon", "our_km", "ok", "checked_at"})
        self.assertNotIn(5.89, r.values())       # Google's km is not in the row
        self.assertEqual(r["our_km"], 5.84)

    def test_no_route(self):
        self.assertIsNone(G.google_close("k", [31.8, 35.2], [31.9, 35.3], 5.0, post=lambda *a: {}))

    def test_skips_without_secrets(self):
        env = {k: os.environ.pop(k) for k in ("GOOGLE_ROUTES_API_KEY", "SUPABASE_SERVICE_ROLE_KEY") if k in os.environ}
        try:
            G.main(["--days"])                    # prints "skipped", no network, no error
        finally:
            os.environ.update(env)


if __name__ == "__main__":
    unittest.main()
