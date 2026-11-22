"""Route warnings with no GPS passage, checked against Google Routes: yes / no only (PRD-deadhead R51, David 22.11.2026).

  python -I tools/google_yesno.py --days data/<slug>/day_<D>.json ... [--op <slug>]

Order of the check (R51): (1) GPS of buses in service on the same stretch (pipeline/gps_verify.py, leg "gv") decides;
(2) only an empty leg with a road warning and no GPS passage is sent to Google (DRIVE, TRAFFIC_UNAWARE), with the same
rule: close = |Google - ours| <= max(tol_pct %, tol_km). Google's answer is used once, in memory, and dropped: kept
is only yes / no and the date of the check (table public.route_gcheck, with OUR km, so a changed leg is asked again).
No km, time, route or geometry from Google is stored anywhere, cached, printed or shown; the dashboard says
"אומת מול ניתוב Google Maps" only in the route warnings list, never next to a map.

Quota: the shared counter (public.google_take: daily_cap / monthly_cap, table google_usage). Needs GOOGLE_ROUTES_API_KEY and
SUPABASE_SERVICE_ROLE_KEY (sb_secret_ in the apikey header); without them it does nothing and never fails the build."""
import datetime as dt, json, math, os, sys, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "pipeline"))
CONF = json.load(open(os.path.join(REPO, "pipeline", "config.json"), encoding="utf-8"))
CFG = dict(tol_pct=15, tol_km=0.5, daily_cap=300, monthly_cap=4500, recheck_days=30, **{k: v for k, v in CONF.get("google_yesno", {}).items() if not k.startswith("_")})
ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes"
SB = os.environ.get("SUPABASE_URL") or "https://xghfcdgettrcdciwwzbl.supabase.co"
ANCH_LOCAL_KM = 0.5  # assets/app.js ANCH_LOCAL_KM


def hav(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0]); dp, dl = p2 - p1, math.radians(b[1] - a[1])
    return 2 * 6371 * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def close(g_km, ours, cfg=CFG):
    return abs(g_km - ours) <= max(cfg["tol_pct"] / 100 * ours, cfg["tol_km"])


def flagged(i):
    """a road warning as the dashboard flags it (detour, or a route check that is not clean)"""
    if i.get("kind") != "empty" or i.get("overlap") or i.get("km") is None or i.get("wait") or not i.get("a") or not i.get("b"): return False
    rt = i.get("rt")
    return (i["km"] > 4 and i["km"] > 2.5 * max(hav(i["a"], i["b"]), 0.01)) or bool(rt and (rt.get("u") or any(m > 30 for m in rt.get("s") or [])))


def pairs_without_gps(days, anchors):
    """{key: (A, B, our km)} of the flagged legs that no bus in service drove (no "gv"); A after the stop anchor, as the dashboard keys it"""
    out = {}
    for d in days:
        for v in d["vehicles"]:
            for i in v["items"]:
                if not flagged(i) or i.get("gv"): continue
                n = (i.get("frm") or "").strip(); x = anchors.get(n) or anchors.get(",".join(n.split(",")[1:]).strip())
                A = x if x and hav(i["a"], i["b"]) >= ANCH_LOCAL_KM else i["a"]
                out.setdefault(f"{A[0]:.5f},{A[1]:.5f};{i['b'][0]:.5f},{i['b'][1]:.5f}", (A, i["b"], i["km"]))
    return out


def http(url, body=None, headers=None, method=None):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=30) as r:
        t = r.read(); return json.loads(t) if t else None


def google_close(key, A, B, ours, post=http):
    """True / False, or None when Google gave no route; Google's numbers never leave this function"""
    body = {"origin": {"location": {"latLng": {"latitude": A[0], "longitude": A[1]}}},
            "destination": {"location": {"latLng": {"latitude": B[0], "longitude": B[1]}}},
            "travelMode": "DRIVE", "routingPreference": "TRAFFIC_UNAWARE", "units": "METRIC"}
    j = post(ENDPOINT, body, {"Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.distanceMeters"}, "POST")
    rs = (j or {}).get("routes") or []
    return close(rs[0].get("distanceMeters", 0) / 1000, ours) if rs else None


def row(A, B, ours, ok, now):
    """the only thing kept: the pair, OUR km, yes / no, the date"""
    return dict(a_lat=round(A[0], 5), a_lon=round(A[1], 5), b_lat=round(B[0], 5), b_lon=round(B[1], 5), our_km=round(ours, 2), ok=ok, checked_at=now)


def main(a):
    gkey, skey = os.environ.get("GOOGLE_ROUTES_API_KEY", "").strip(), os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not gkey or not skey:
        print("Google yes/no check skipped: secret missing"); return
    slug = a[a.index("--op") + 1] if "--op" in a else "derech-egged"
    h = {"apikey": skey, "Content-Type": "application/json", **({} if skey.startswith("sb_") else {"Authorization": "Bearer " + skey})}
    op = http(f"{SB}/rest/v1/operators?select=id&slug=eq.{slug}", headers=h)[0]["id"]
    st = http(f"{SB}/rest/v1/settings?select=value&key=eq.stop_anchors&operator_id=eq.{op}", headers=h) or []
    anchors = {x["name"].strip(): [round(float(x["lat"]), 5), round(float(x["lon"]), 5)] for x in (st[0]["value"] if st else []) or []
               if (x.get("name") or "").strip() and x.get("lat") not in (None, "") and x.get("lon") not in (None, "")}
    files = [x for x in a[a.index("--days") + 1:] if x.endswith(".json")] if "--days" in a else []
    todo = pairs_without_gps([json.load(open(f, encoding="utf-8")) for f in files], anchors)
    have = {f'{float(r["a_lat"]):.5f},{float(r["a_lon"]):.5f};{float(r["b_lat"]):.5f},{float(r["b_lon"]):.5f}': r
            for r in http(f"{SB}/rest/v1/route_gcheck?select=a_lat,a_lon,b_lat,b_lon,our_km,checked_at&operator_id=eq.{op}", headers=h) or []}
    now = dt.datetime.now(dt.timezone.utc); rows, calls, kept, stop = [], 0, 0, None
    for k, (A, B, ours) in todo.items():
        r = have.get(k)
        if r and abs(float(r["our_km"]) - ours) <= 0.05 and now - dt.datetime.fromisoformat(r["checked_at"]) < dt.timedelta(days=CFG["recheck_days"]):
            kept += 1; continue  # same km, checked lately: the yes / no stands
        if not http(f"{SB}/rest/v1/rpc/google_take", dict(month_cap=CFG["monthly_cap"], day_cap=CFG["daily_cap"]), h, "POST"):
            stop = "cap"; break
        try:
            ok = google_close(gkey, A, B, ours)
        except urllib.error.HTTPError as e:
            print("Google HTTP", e.code); continue
        except Exception as e:  # noqa: BLE001 - only the type: the key is a header, never in a message
            print("Google error", type(e).__name__); continue
        calls += 1
        if ok is not None: rows.append(row(A, B, ours, ok, now.isoformat()))
    if rows:
        http(f"{SB}/rest/v1/route_gcheck?on_conflict=operator_id,a_lat,a_lon,b_lat,b_lon", [dict(x, operator_id=op) for x in rows],
             dict(h, Prefer="resolution=merge-duplicates,return=minimal"), "POST")
    print(json.dumps(dict(pairs_without_gps=len(todo), kept=kept, calls=calls, stopped=stop, yes=sum(r["ok"] for r in rows), no=sum(not r["ok"] for r in rows))))


if __name__ == "__main__":
    main(sys.argv[1:])
