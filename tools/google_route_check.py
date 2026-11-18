"""Check the dashboard's route warnings against Google Routes (PRD-deadhead R51).

  nightly / with the database:  python -I tools/google_route_check.py --days data/<slug>/day_<D>.json ... [--op <slug>]
  local, from the page:         python -I tools/google_route_check.py <problems.json> [<out.sql>]

Pairs: each origin -> destination of an empty leg with a road warning (detour: road > 2.5 x air and > 4 km; suspect
route: route check unresolved; "time" alone is about time, not the road). --days reads the plaintext day files of the
build (the origin moved to the stop anchor of settings "stop_anchors", as the dashboard routes it); <problems.json> is
routeProblems() of assets/app.js dumped from the page ({day: [{A, B, km, kinds, frm, to, legs}]}). Google computes a
DRIVE route (TRAFFIC_UNAWARE); close (pipeline/config.json google_check: |google - ours| <= max(tol_pct % of ours,
tol_km)) -> ok. One row per pair in public.route_google; a pair already there is not asked again (its Google km is
reused with today's km).

Database mode (SUPABASE_SERVICE_ROLE_KEY set): route_google is the answer cache, calls are counted in the shared counter
(public.google_take: monthly_cap / daily_cap, local and nightly runs alike), rows upserted through the REST API.
Without it: answers cached in $DEADHEAD_CACHE/google_routes.json, calls counted in $GOOGLE_LEDGER, and <out.sql> holds
the upsert plus the calls to add to public.google_usage. No GOOGLE_ROUTES_API_KEY: only cached answers, never an error.
Keys are never printed or written."""
import datetime as dt, json, math, os, sys, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(HERE)
CFG = json.load(open(os.path.join(REPO, "pipeline", "config.json"), encoding="utf-8"))["google_check"]
ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes"
SB = os.environ.get("SUPABASE_URL") or "https://xghfcdgettrcdciwwzbl.supabase.co"
ROAD = {"detour", "route", "okchg"}
SNAP_M, ANCH_LOCAL_KM = 30, 0.5  # assets/route.js SNAP_M, assets/app.js ANCH_LOCAL_KM


def hav(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0]); dp, dl = p2 - p1, math.radians(b[1] - a[1])
    return 2 * 6371 * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def http(url, body=None, headers=None, method=None):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=30) as r:
        t = r.read(); return json.loads(t) if t else None


class DB:
    def __init__(self, key, slug):
        self.h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}
        self.op = http(f"{SB}/rest/v1/operators?select=id&slug=eq.{slug}", headers=self.h)[0]["id"]

    def get(self, table, q): return http(f"{SB}/rest/v1/{table}?{q}&operator_id=eq.{self.op}", headers=self.h) or []

    def take(self): return bool(http(f"{SB}/rest/v1/rpc/google_take", dict(month_cap=CFG["monthly_cap"], day_cap=CFG["daily_cap"]), self.h, "POST"))

    def upsert(self, rows):
        http(f"{SB}/rest/v1/route_google?on_conflict=operator_id,a_lat,a_lon,b_lat,b_lon", [dict(r, operator_id=self.op) for r in rows],
             dict(self.h, Prefer="resolution=merge-duplicates,return=minimal"), "POST")


def anchors(db):
    rows = db.get("settings", "select=value&key=eq.stop_anchors") if db else []
    L = rows[0]["value"] if rows else []
    return {x["name"].strip(): [round(float(x["lat"]), 5), round(float(x["lon"]), 5)] for x in L or []
            if (x.get("name") or "").strip() and x.get("lat") not in (None, "") and x.get("lon") not in (None, "")}


def from_days(files, anc):
    out = {}
    for f in files:
        d = json.load(open(f, encoding="utf-8")); gs = out.setdefault(d["day"], [])
        for v in d["vehicles"]:
            for i in v["items"]:
                if i["kind"] != "empty" or i.get("overlap") or i.get("km") is None or i.get("wait") or not i.get("a") or not i.get("b"): continue
                k = []
                if i["km"] > 4 and i["km"] > 2.5 * max(hav(i["a"], i["b"]), 0.01): k.append("detour")
                rt = i.get("rt")
                # also when the build marked it "ok": the dashboard re-checks the route (road cache, approved links) and may flag it
                if rt and (rt.get("u") or any(m > SNAP_M for m in rt.get("s") or [])): k.append("route")
                if not k: continue
                n = (i.get("frm") or "").strip(); x = anc.get(n) or anc.get(",".join(n.split(",")[1:]).strip())
                A = x if x and hav(i["a"], i["b"]) >= ANCH_LOCAL_KM else i["a"]
                gs.append(dict(A=A, B=i["b"], km=i["km"], kinds=k, frm=i.get("frm"), to=i.get("to"), legs=[[v["veh"], i["start"]]]))
    return out


def main(a):
    gkey = os.environ.get("GOOGLE_ROUTES_API_KEY", "").strip()
    skey = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    slug = a[a.index("--op") + 1] if "--op" in a else "derech-egged"
    db = DB(skey, slug) if skey else None
    if "--days" in a:
        files = [x for x in a[a.index("--days") + 1:] if not x.startswith("--") and x.endswith(".json")]
        probs, out = from_days(files, anchors(db)), None
    else:
        probs, out = json.load(open(a[0], encoding="utf-8")), (a[1] if len(a) > 1 else None)
    pk = lambda p: f"{p[0]:.5f},{p[1]:.5f}"
    pairs = {}
    for day, gs in probs.items():
        for g in gs:
            if not ROAD & set(g["kinds"]): continue
            p = pairs.setdefault(pk(g["A"]) + ";" + pk(g["B"]), dict(A=g["A"], B=g["B"], km=g["km"], frm=g["frm"], to=g["to"], legs=0, days=set()))
            p["legs"] += len(g["legs"]); p["days"].add(day)
    # the answer cache: route_google (database) or the local file
    if db:
        cache = {f'{float(r["a_lat"]):.5f},{float(r["a_lon"]):.5f};{float(r["b_lat"]):.5f},{float(r["b_lon"]):.5f}':
                 (None if r["g_km"] is None else dict(km=float(r["g_km"]), min=None if r["g_min"] is None else float(r["g_min"])))
                 for r in db.get("route_google", "select=a_lat,a_lon,b_lat,b_lon,g_km,g_min")}
    else:
        cache_f = os.path.join(os.environ.get("DEADHEAD_CACHE") or os.path.join(REPO, "pipeline", "cache"), "google_routes.json")
        cache = json.load(open(cache_f, encoding="utf-8")) if os.path.exists(cache_f) else {}
        led_f = os.environ.get("GOOGLE_LEDGER") or os.path.join(REPO, "..", "maps", "traveltime", "google_usage.json")
        led = json.load(open(led_f, encoding="utf-8")) if os.path.exists(led_f) else {}
        now = dt.datetime.now(dt.timezone.utc); mk, dk = now.strftime("%Y-%m"), "d:" + now.strftime("%Y-%m-%d")
    calls = cached = 0; stop = None
    for k, p in pairs.items():
        if k in cache:
            cached += 1
        elif stop is None:
            if not gkey: stop = "no Google key"
            elif db and not db.take(): stop = "cap"
            elif not db and (led.get(mk, 0) >= CFG["monthly_cap"] or led.get(dk, 0) >= CFG["daily_cap"]): stop = "cap"
            if stop is None:
                if not db:  # counted before the call: a failed call may be billed
                    led[mk] = led.get(mk, 0) + 1; led[dk] = led.get(dk, 0) + 1; json.dump(led, open(led_f, "w", encoding="utf-8"))
                body = {"origin": {"location": {"latLng": {"latitude": p["A"][0], "longitude": p["A"][1]}}},
                        "destination": {"location": {"latLng": {"latitude": p["B"][0], "longitude": p["B"][1]}}},
                        "travelMode": "DRIVE", "routingPreference": "TRAFFIC_UNAWARE", "units": "METRIC"}
                try:
                    j = http(ENDPOINT, body, {"Content-Type": "application/json", "X-Goog-Api-Key": gkey,
                                              "X-Goog-FieldMask": "routes.duration,routes.distanceMeters"}, "POST")
                except urllib.error.HTTPError as e:
                    print("Google HTTP", e.code); continue
                except Exception as e:  # noqa: BLE001 - only the type: the key is a header, never in a message
                    print("Google error", type(e).__name__); continue
                rs = j.get("routes") or []
                cache[k] = dict(km=round(rs[0].get("distanceMeters", 0) / 1000, 2), min=round(float(rs[0]["duration"].rstrip("s")) / 60, 1)) if rs else None
                calls += 1
                if not db:
                    os.makedirs(os.path.dirname(cache_f), exist_ok=True); json.dump(cache, open(cache_f, "w", encoding="utf-8"))
        if k in cache:
            g = cache[k]; p["g"] = g
            p["ok"] = bool(g) and abs(g["km"] - p["km"]) <= max(CFG["tol_pct"] / 100 * p["km"], CFG["tol_km"])
    rows = [dict(a_lat=round(p["A"][0], 5), a_lon=round(p["A"][1], 5), b_lat=round(p["B"][0], 5), b_lon=round(p["B"][1], 5), our_km=round(p["km"], 2),
                 g_km=p["g"] and p["g"]["km"], g_min=p["g"] and p["g"]["min"], ok=p["ok"], origin=p["frm"], destination=p["to"],
                 checked_at=dt.datetime.now(dt.timezone.utc).isoformat())
            for p in pairs.values() if "ok" in p]
    if db and rows:
        db.upsert(rows)
    elif out:
        q = lambda s: "null" if s is None else "'" + str(s).replace("'", "''") + "'"
        n = lambda x: "null::numeric" if x is None else f"{float(x)}"
        sql = ""
        if rows:
            sql = ("insert into public.route_google (operator_id,a_lat,a_lon,b_lat,b_lon,our_km,g_km,g_min,ok,origin,destination)\n"
                   "select o.id, v.* from public.operators o, (values\n" + ",\n".join(
                       f"({r['a_lat']:.5f},{r['a_lon']:.5f},{r['b_lat']:.5f},{r['b_lon']:.5f},{r['our_km']:.2f},{n(r['g_km'])},{n(r['g_min'])},{str(r['ok']).lower()},{q(r['origin'])},{q(r['destination'])})"
                       for r in rows) + f"\n) v(a_lat,a_lon,b_lat,b_lon,our_km,g_km,g_min,ok,origin,destination) where o.slug = {q(slug)}\n"
                   "on conflict (operator_id,a_lat,a_lon,b_lat,b_lon) do update set our_km=excluded.our_km, g_km=excluded.g_km, g_min=excluded.g_min, ok=excluded.ok, checked_at=now();\n")
        if calls:  # the shared counter learns about the local calls
            sql += (f"insert into public.google_usage(period,n) values ({q(mk)},{calls}),({q(dk[2:])},{calls}) "
                    "on conflict (period) do update set n = public.google_usage.n + excluded.n;\n")
        if sql: open(out, "w", encoding="utf-8").write(sql)
    ok = [p for p in pairs.values() if p.get("ok")]; gap = [p for p in pairs.values() if "ok" in p and not p["ok"]]
    print(json.dumps(dict(mode="database" if db else "local", pairs=len(pairs), cached=cached, calls=calls, stopped=stop, ok=len(ok),
                          ok_legs=sum(p["legs"] for p in ok), gap=len(gap), gap_legs=sum(p["legs"] for p in gap)), ensure_ascii=False))
    for p in sorted(gap, key=lambda p: -abs((p["g"] or {}).get("km", 0) - p["km"])):
        print(f'  gap: {p["frm"]} -> {p["to"]}: ours {p["km"]:.1f} km, Google {p["g"]["km"] if p["g"] else "-"} km, {p["legs"]} legs, {sorted(p["days"])[0]}')


if __name__ == "__main__":
    main(sys.argv[1:])
