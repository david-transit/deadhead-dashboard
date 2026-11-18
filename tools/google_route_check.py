"""Check the dashboard's route warnings against Google Routes (PRD-deadhead R51). Runs locally (the nightly has no key).

  python -I tools/google_route_check.py <problems.json> <out.sql>

<problems.json>: {day: [{A, B, km, kinds, frm, to, legs}, ...]} - the route problems ("בעיות מסלול") as the dashboard
computes them (routeProblems() in assets/app.js, dumped from the page). For each origin/destination pair with a road
warning (detour / suspect route / changed since approved; "time" alone is about time, not the road) Google computes a
DRIVE route (TRAFFIC_UNAWARE). Close (pipeline/config.json google_check: |google - ours| <= max(tol_pct % of ours,
tol_km)) -> ok. <out.sql> upserts public.route_google (one row per pair), run with the service role / SQL editor.

Key: $GOOGLE_ROUTES_API_KEY (never printed or written). Spending guard: answers cached per pair in
$DEADHEAD_CACHE/google_routes.json (or pipeline/cache), and calls counted in the shared ledger ($GOOGLE_LEDGER, default
../maps/traveltime/google_usage.json, {"YYYY-MM": n, "d:YYYY-MM-DD": n}); stops at monthly_cap / daily_cap."""
import datetime as dt, json, os, sys, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(HERE)
CFG = json.load(open(os.path.join(REPO, "pipeline", "config.json"), encoding="utf-8"))["google_check"]
ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes"
ROAD = {"detour", "route", "okchg"}


def main(src, out):
    key = os.environ.get("GOOGLE_ROUTES_API_KEY", "").strip()
    cache_f = os.path.join(os.environ.get("DEADHEAD_CACHE") or os.path.join(REPO, "pipeline", "cache"), "google_routes.json")
    led_f = os.environ.get("GOOGLE_LEDGER") or os.path.join(REPO, "..", "maps", "traveltime", "google_usage.json")
    cache = json.load(open(cache_f, encoding="utf-8")) if os.path.exists(cache_f) else {}
    led = json.load(open(led_f, encoding="utf-8")) if os.path.exists(led_f) else {}
    now = dt.datetime.now(dt.timezone.utc); mk, dk = now.strftime("%Y-%m"), "d:" + now.strftime("%Y-%m-%d")
    pairs = {}
    for day, gs in json.load(open(src, encoding="utf-8")).items():
        for g in gs:
            if not ROAD & set(g["kinds"]): continue
            k = f'{g["A"][0]:.5f},{g["A"][1]:.5f};{g["B"][0]:.5f},{g["B"][1]:.5f}'
            p = pairs.setdefault(k, dict(A=g["A"], B=g["B"], km=g["km"], frm=g["frm"], to=g["to"], legs=0, days=set()))
            p["legs"] += len(g["legs"]); p["days"].add(day)
    calls = stop = 0
    for k, p in pairs.items():
        if k not in cache:
            if not key: stop = "no key"; break
            if led.get(mk, 0) >= CFG["monthly_cap"] or led.get(dk, 0) >= CFG["daily_cap"]: stop = "cap"; break
            led[mk] = led.get(mk, 0) + 1; led[dk] = led.get(dk, 0) + 1  # counted before the call: a failed call may be billed
            json.dump(led, open(led_f, "w", encoding="utf-8"))
            body = {"origin": {"location": {"latLng": {"latitude": p["A"][0], "longitude": p["A"][1]}}},
                    "destination": {"location": {"latLng": {"latitude": p["B"][0], "longitude": p["B"][1]}}},
                    "travelMode": "DRIVE", "routingPreference": "TRAFFIC_UNAWARE", "units": "METRIC"}
            req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), method="POST", headers={
                "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.duration,routes.distanceMeters"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r: j = json.load(r)
            except urllib.error.HTTPError as e:
                print("Google HTTP", e.code); continue
            except Exception as e:  # noqa: BLE001 - the message could carry the URL, never the key (it is a header)
                print("Google error", type(e).__name__); continue
            rs = j.get("routes") or []
            cache[k] = dict(km=round(rs[0].get("distanceMeters", 0) / 1000, 2), min=round(float(rs[0]["duration"].rstrip("s")) / 60, 1)) if rs else None
            calls += 1
            os.makedirs(os.path.dirname(cache_f), exist_ok=True); json.dump(cache, open(cache_f, "w", encoding="utf-8"))
        g = cache[k]
        p["g"] = g; p["ok"] = bool(g) and abs(g["km"] - p["km"]) <= max(CFG["tol_pct"] / 100 * p["km"], CFG["tol_km"])
    n = lambda x: "null::numeric" if x is None else f"{float(x)}"
    q = lambda s: "null" if s is None else "'" + str(s).replace("'", "''") + "'"
    rows = [f"({p['A'][0]:.5f},{p['A'][1]:.5f},{p['B'][0]:.5f},{p['B'][1]:.5f},{p['km']:.2f},{n(p['g'] and p['g']['km'])},{n(p['g'] and p['g']['min'])},{str(p['ok']).lower()},{q(p['frm'])},{q(p['to'])})"
            for p in pairs.values() if "ok" in p]
    if rows:
        open(out, "w", encoding="utf-8").write(
            "insert into public.route_google (operator_id,a_lat,a_lon,b_lat,b_lon,our_km,g_km,g_min,ok,origin,destination)\n"
            "select o.id, v.* from public.operators o, (values\n" + ",\n".join(rows) + "\n) v(a_lat,a_lon,b_lat,b_lon,our_km,g_km,g_min,ok,origin,destination) where o.slug = 'derech-egged'\n"
            "on conflict (operator_id,a_lat,a_lon,b_lat,b_lon) do update set our_km=excluded.our_km, g_km=excluded.g_km, g_min=excluded.g_min, ok=excluded.ok, checked_at=now();\n")
    ok = [p for p in pairs.values() if p.get("ok")]; gap = [p for p in pairs.values() if "ok" in p and not p["ok"]]
    print(json.dumps(dict(pairs=len(pairs), calls=calls, stopped=stop, ok=len(ok), ok_legs=sum(p["legs"] for p in ok), gap=len(gap),
                          gap_legs=sum(p["legs"] for p in gap), month=led.get(mk, 0), today=led.get(dk, 0)), ensure_ascii=False))
    for p in sorted(gap, key=lambda p: -abs((p["g"] or {}).get("km", 0) - p["km"])):
        print(f'  gap: {p["frm"]} -> {p["to"]}: ours {p["km"]:.1f} km, Google {p["g"]["km"] if p["g"] else "-"} km, {p["legs"]} legs, {sorted(p["days"])[0]}')


if __name__ == "__main__":
    main(*sys.argv[1:3])
