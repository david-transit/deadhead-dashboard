"""Build one day for one operator:  python pipeline/build_day.py YYYY-MM-DD [--op derech-egged]

Fetches the operator's rides (Open Bus Stride) and each ride's first/last SIRI GPS point, finds route ends, computes
trips and empty legs (OSRM road km), writes plaintext data/<slug>/day_<day>.json (gitignored), encrypts it to
data/<slug>/day_<day>.js, refreshes the cross-day index data/<slug>/ends_<YYYY-MM>.js and rewrites data/<slug>/days.js.
Operators: pipeline/operators.json.

Trip ends/times are the ride's actual first/last GPS point (planned route ends only when GPS is missing, marked no_gps).
A very short ride followed shortly by a ride of the same line is one physical trip ("dup" item, התחלה כפולה).
A ride SIRI never tracked (no valid position, 0 minutes) is not performed ("ghost" item, not counted).
Night legs (overnight, depot <-> first/last stop, overnight reinforcement) are computed in the browser (assets/core.js)
from the ends index, the Supabase settings and the overnight choices.

Caches (never committed, shared by all operators): pipeline/cache/ or $DEADHEAD_CACHE.
Data key (per operator): $DATA_KEY_FILE or config/.data_key_<slug> ("<kid>:<base64 32 bytes>", pipeline/keys.js)."""
import json, sys, os, glob, hashlib, subprocess, math, datetime as dt, urllib.request, time, zipfile, csv, io, collections, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from stride import TZ, operator, fetch_rides, update_route_ends, fetch_locations

REPO = os.path.dirname(HERE)
CACHE_DIR = os.environ.get("DEADHEAD_CACHE") or os.path.join(HERE, "cache")
OP = DATA = KEY_FILE = DAY_START_H = None  # set per operator in main()

# --- reading SIRI GPS (tunable) ---
SNAP_KM = 0.4          # a GPS end within this of a known terminal stop is that stop (stable names, shared road cache)
NEAR_KM = 3.0          # within this: "ליד <stop>"
DONE_SHARE = 0.85      # a ride is completed when GPS shows >= 85% of the route ...
DONE_KM = 2.0          # ... or it ended within 2 km of the route's last stop; otherwise "לא הושלמה לפי GPS"
FALSE_START_MIN = 12   # a ride this short (or < 25% of its route) ...
FALSE_START_GAP = 20   # ... followed within 20 min by a ride of the same line it could reach = one trip (התחלה כפולה)
LATE_M = 1500          # first GPS point further along the route than this = logged in late
TIGHT_MIN = 10         # empty leg needing more than gap + 10 min of driving (or > 100 km/h) is flagged "tight" (data warning)
ROUTE_V = 3            # assets/route.js V: cached routes checked by an older version are routed again
# Road profile (pipeline/osrm/README.md): with OSRM_BASE set (our own osrm-routed, bus-strict), cached routes of another
# profile (car, or a car fallback) are routed again; without it the public car server is used, as before.
PROFILE = os.environ.get("OSRM_PROFILE", "bus-strict") if os.environ.get("OSRM_BASE") else "car"
# A trip that GPS lost shortly before its planned last stop ("ליד …") ends at that stop only when all hold (David,
# 17.11.2026): it covered >= share of the planned km, the last point is <= max_km from the stop and before it along the
# route, and the time to the next trip is enough to drive the rest at the line's planned speed. The end time stays the
# GPS time. Otherwise the raw point stays, marked trunc_end ("קטיעה אפשרית"). The same, mirrored, for the start.
# pipeline/config.json "gps_end_snap" (settings, not code); GPS_END_SNAP=0 turns it off (before/after comparison).
SNAP = dict(dict(enabled=True, share=0.95, max_km=1.0, before_tol_km=0.0, start_share=0.05, start_max_km=1.0),
            **json.load(open(os.path.join(HERE, "config.json"), encoding="utf-8")).get("gps_end_snap", {}))
if os.environ.get("GPS_END_SNAP") == "0": SNAP["enabled"] = False
IL = (29.0, 34.0, 34.0, 36.5)  # valid GPS (lat/lon box); SIRI sends -1,-1 for "no position"


def hav(a, b):
    R, r = 6371, math.radians
    dp, dl = r(b[0] - a[0]), r(b[1] - a[1])
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(r(a[0])) * math.cos(r(b[0])) * math.sin(dl / 2) ** 2))


def osrm_router(cache_file):
    """Road km/min between two points: cache, then OSRM through assets/route.js (pipeline/route.js, one node process),
    which flags and fixes bad snapping (U-turns, revisits, far snaps, motorway at a terminal). Cache entries:
    [km, min, meta]; entries without meta or with an older route check version (meta.v < ROUTE_V) are routed again."""
    cache = json.load(open(cache_file, encoding="utf-8")) if os.path.exists(cache_file) else {}
    miss = [0]; proc = [None]; stat = collections.Counter()

    def ask(p, q, term):
        if proc[0] is None:
            proc[0] = subprocess.Popen(["node", os.path.join(HERE, "route.js")], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       text=True, encoding="utf-8", bufsize=1)
        proc[0].stdin.write(json.dumps(dict(a=p, b=q, t=term)) + "\n"); proc[0].stdin.flush()
        return json.loads(proc[0].stdout.readline() or "null")

    def road(p, q, term=(True, True)):
        """-> (km, min, meta) ; meta = {s:[snap m], fix?, km0?, via?, u?, ok?, why?} ; (None, None, None) when OSRM failed."""
        if hav(p, q) < 0.05:
            return 0.0, 0.0, None
        k = f"{p[0]:.5f},{p[1]:.5f};{q[0]:.5f},{q[1]:.5f}"  # same rounding as the browser's road_cache key
        c = cache.get(k)
        if not c or len(c) < 3 or (c[2] or {}).get("v", 0) < ROUTE_V or (c[2] or {}).get("p", "car") != PROFILE or (c[2] or {}).get("fb"):
            r = ask([round(p[0], 5), round(p[1], 5)], [round(q[0], 5), round(q[1], 5)], list(term))
            if not r:
                miss[0] += 1
                return None, None, None
            old = c[0] if c else None
            meta = {x: r[x] for x in ("v", "s", "fix", "km0", "via", "u", "ok", "why", "p", "fb") if x in r}
            cache[k] = c = [r["km"], r["min"], meta]
            stat["routed"] += 1
            if stat["routed"] % 200 == 0:  # keep the work if the run is cut short (CI timeout)
                json.dump(cache, open(cache_file, "w", encoding="utf-8"))
                print("routes so far:", dict(stat), flush=True)
            if r.get("why"): stat["suspicious"] += 1
            if r.get("fix"): stat["fixed"] += 1
            if r.get("fb"): stat["car_fallback"] += 1
            if old is not None and abs(old - r["km"]) > 0.05: stat["changed"] += 1; stat["delta_km"] += r["km"] - old
        return c[0], c[1], c[2]

    def save():
        if proc[0] is not None:
            proc[0].stdin.close(); proc[0].wait(); proc[0] = None
        json.dump(cache, open(cache_file, "w", encoding="utf-8"))
        if stat: print("routes:", dict(stat))

    return road, save, miss


def stop_index(ends):
    pts = {}
    for e in ends.values():
        for q in (e["o"], e["d"]):
            pts[(round(q[0], 5), round(q[1], 5))] = (q[2], q[3])
    return [(la, lo, n, c) for (la, lo), (n, c) in pts.items()]


def locator(stops):
    def at(pos):
        """GPS point -> ([lat, lon], place name, city). Snaps to a known terminal stop when close."""
        best, bd = None, 1e9
        for s in stops:
            if abs(s[0] - pos[0]) > 0.3 or abs(s[1] - pos[1]) > 0.3: continue
            d = hav(pos, s)
            if d < bd: best, bd = s, d
        if best is None:
            return [round(pos[0], 4), round(pos[1], 4)], "מיקום GPS", "לא ידוע"
        if bd <= SNAP_KM:
            return [round(best[0], 5), round(best[1], 5)], f"{best[3]}, {best[2]}", best[3]
        pre = "ליד " if bd <= NEAR_KM else "מיקום GPS ליד "
        return [round(pos[0], 4), round(pos[1], 4)], f"{pre}{best[2]}, {best[3]}", best[3]
    return at


def merge_false_starts(ts):
    """A very short ride followed shortly by a ride of the same line that it could reach = one physical trip.
    The short ride becomes a "dup" item (not a trip, not reinforcement, no empty leg); the trip starts where it began."""
    out, dups = [], []
    tiny = lambda r: r.get("incomplete") and ((r["end"] - r["start"] <= FALSE_START_MIN) or (
        r.get("gps_km") is not None and r.get("km_plan") and r["gps_km"] < 0.25 * r["km_plan"]))
    dup = lambda r, into: dict(kind="dup", start=r["start"], end=r["end"], line=r["line"], sched=r["sched"], frm=r["frm"], to=r["to"],
                               merged_into=into["sched"], **({"auto": True} if r.get("auto") else {}))
    for t in ts:
        p = out[-1] if out else None
        # the same line logged twice at the same time (one of them barely moves): one physical trip
        if p and p["line_ref"] == t["line_ref"] and t["start"] < p["end"] and (tiny(t) or tiny(p)):
            if tiny(t):
                dups.append(dup(t, p)); continue
            dups.append(dup(p, t)); out[-1] = t; continue
        # one physical trip split over two SIRI journeys of the same line: the second starts where the first stopped
        if (p and p["line_ref"] == t["line_ref"] and t.get("late_login") and p.get("gps_km") is not None and t.get("f_km") is not None
                and -2 <= t["f_t"] - p["end"] <= 5 and abs(t["f_km"] - p["gps_km"]) <= 2):
            keep, other = (p, t) if t.get("auto") and not p.get("auto") else (t, p)
            m = dict(keep, start=p["start"], a=p["a"], frm=p["frm"], ca=p["ca"], end=t["end"], b=t["b"], to=t["to"], cb=t["cb"],
                     km=t["km"], gps_km=t["gps_km"], sched=keep["sched"])
            m.pop("late_login", None)
            if not t.get("incomplete"): m.pop("incomplete", None)
            dups.append(dict(dup(other, m), continued=True)); out[-1] = m; continue
        if p and t.get("late_login") and t["start"] < p["end"] + hav(p["b"], t["a"]) * 1.35 / 40 * 60:
            # no time to reach the route's first stop: it joined the route midway, where GPS first saw it
            t["start"], t["a"], t["frm"], t["ca"] = t.pop("g0")
            t["midroute"] = t.pop("late_login")
            if t.get("gps_km") is not None: t["km"] = round(max(t["gps_km"] - t["midroute"], 0), 1)
        if p and p["line_ref"] == t["line_ref"] and not p.get("no_gps") and not t.get("no_gps"):
            short = (p["end"] - p["start"] <= FALSE_START_MIN) or (
                p.get("gps_km") is not None and p.get("km_plan") and p["gps_km"] < 0.25 * p["km_plan"])
            gap = t["start"] - p["end"]
            reach = hav(p["b"], t["a"]) <= max(gap, 0) * 1.5 + 2
            if short and (p.get("incomplete") or p.get("unmapped")) and -5 <= gap <= FALSE_START_GAP and reach:
                dups.append(dict(kind="dup", start=p["start"], end=p["end"], line=p["line"], sched=p["sched"], frm=p["frm"], to=p["to"],
                                 merged_into=t["sched"], **({"auto": True} if p.get("auto") else {})))
                t.update(start=p["start"], a=p["a"], frm=p["frm"], ca=p["ca"]); t.pop("late_login", None)
                out[-1] = t
                continue
        out.append(t)
    return out, dups


RAW = ("ליד", "מיקום")


def snap_ends(ts):
    """Move a GPS trip end (start) that is a raw point to the planned last (first) stop under the strict rule (SNAP).
    Runs on one vehicle's trips in order, after merge_false_starts: the next/previous trip is the next/previous event."""
    if not SNAP["enabled"]: return
    for i, t in enumerate(ts):
        if t.get("no_gps") or not t.get("km_plan") or not t.get("dur"): continue
        v = t["km_plan"] / t["dur"]  # planned km per minute
        g = t.get("gps_km")
        if t["d"] and t["to"].startswith(RAW):
            d, why = t["d"], []
            if g is None or g < SNAP["share"] * t["km_plan"]: why.append("share")
            if hav(t["b"], d) > SNAP["max_km"] or (g is not None and g > t["km_plan"] + SNAP["before_tol_km"]): why.append("far")
            nx = ts[i + 1] if i + 1 < len(ts) else None
            if nx is not None and g is not None and nx["start"] - t["end"] < max(t["km_plan"] - g, 0) / v: why.append("time")
            if why:
                t["trunc_end"] = why
            else:
                t["snap_end"] = dict(b=t["b"], to=t["to"], m=round(hav(t["b"], d) * 1000))
                t.update(b=[round(d[0], 5), round(d[1], 5)], to=f'{d[3]}, {d[2]}', cb=d[3])
        f = t.get("f_km")
        if t["o"] and t["frm"].startswith(RAW) and not t.get("late_login") and not t.get("midroute"):
            o, why = t["o"], []
            if f is None or f > SNAP["start_share"] * t["km_plan"]: why.append("share")
            if hav(t["a"], o) > SNAP["start_max_km"]: why.append("far")
            pv = ts[i - 1] if i else None
            if pv is not None and f is not None and t.get("f_t") is not None and t["f_t"] - pv["end"] < f / v: why.append("time")
            if why:
                t["trunc_start"] = why
            else:
                t["snap_start"] = dict(a=t["a"], frm=t["frm"], m=round(hav(t["a"], o) * 1000))
                t.update(a=[round(o[0], 5), round(o[1], 5)], frm=f'{o[3]}, {o[2]}', ca=o[3])


def build(day):
    os.makedirs(CACHE_DIR, exist_ok=True)
    rf = os.path.join(CACHE_DIR, f"rides_{OP['slug']}_{day}_h{DAY_START_H}.json")
    raw = json.load(open(rf, encoding="utf-8")) if os.path.exists(rf) else fetch_rides(day, rf, OP["operator_ref"], DAY_START_H)
    ends = update_route_ends(raw, os.path.join(CACHE_DIR, "route_ends.json"))
    LOC = fetch_locations(raw, os.path.join(CACHE_DIR, f"vloc_{OP['slug']}_{day}.json"))
    at = locator(stop_index(ends))
    z = zipfile.ZipFile(os.path.join(HERE, "ClusterToLine.zip")).read("ClusterToLine.txt").decode("utf-8-sig")
    CL = {x["OfficeLineId"]: ("עירוני" if x["LineTypeDesc"] == "עירוני" else "בינעירוני")
          for x in csv.DictReader(io.StringIO(z)) if OP["cluster_operator_name"] in x["OperatorName"]}
    road, save_osrm, osrm_miss = osrm_router(os.path.join(CACHE_DIR, "osrm_cache.json"))

    midnight = dt.datetime.fromisoformat(day)  # local wall clock; times after the next midnight stay >= 1440
    P = lambda s: dt.datetime.fromisoformat(s).astimezone(TZ).replace(tzinfo=None)
    mins = lambda t: (t - midnight).total_seconds() / 60

    # SIRI line_ref -> known GTFS route (from matched rides of this day and earlier days, cached)
    lr_file = os.path.join(CACHE_DIR, "line_refs.json")
    LR = json.load(open(lr_file, encoding="utf-8")) if os.path.exists(lr_file) else {}
    for x in raw:
        if x["gtfs_ride_id"] and x["siri_route__line_ref"] and x["gtfs_ride__gtfs_route_id"]:
            LR[str(x["siri_route__line_ref"])] = dict(route=x["gtfs_ride__gtfs_route_id"], line=x["gtfs_route__route_short_name"],
                                                      mkt=x["gtfs_route__route_mkt"], seen=day)
    json.dump(LR, open(lr_file, "w", encoding="utf-8"), ensure_ascii=False)

    by = collections.defaultdict(list); seen = set(); skipped = 0; auto_n = 0; auto_unmapped = 0
    ghosts = collections.defaultdict(list)
    G = collections.Counter()
    for x in raw:
        if not x["vehicle_ref"]:
            skipped += 1; continue
        k = (x["vehicle_ref"], x["scheduled_start_time"])
        if k in seen: continue
        st = P(x["scheduled_start_time"])
        if x["gtfs_ride_id"]:
            e = ends.get(str(x["gtfs_ride__gtfs_route_id"]))
            if not e or not x["gtfs_ride__start_time"]:
                skipped += 1; continue
            dur = (dt.datetime.fromisoformat(x["gtfs_ride__end_time"]) - dt.datetime.fromisoformat(x["gtfs_ride__start_time"])).total_seconds() / 60
            t = dict(line=x["gtfs_route__route_short_name"], mkt=x["gtfs_route__route_mkt"], o=e["o"], d=e["d"], km_plan=round(e["km"], 1))
        else:
            # ran in service but not in the licensed GTFS schedule -> automatic reinforcement candidate
            info = LR.get(str(x["siri_route__line_ref"]))
            e = ends.get(str(info["route"])) if info else None
            dur = x["duration_minutes"] or 30
            t = dict(line=info["line"] if info else "?", mkt=info["mkt"] if info else None,
                     o=e["o"] if e else None, d=e["d"] if e else None, km_plan=round(e["km"], 1) if e else None,
                     auto=True, **({} if e else {"unmapped": True}))
        t["line_ref"] = x["siri_route__line_ref"]; t["dur"] = dur
        sched = mins(st)
        f, l = LOC.get(str(x.get("first_vehicle_location_id"))), LOC.get(str(x.get("last_vehicle_location_id")))
        ok = lambda q: q and q[1] is not None and IL[0] < q[1] < IL[1] and IL[2] < q[2] < IL[3]
        if (f or l) and not (ok(f) or ok(l)) and not x["duration_minutes"]:
            # SIRI attached the ride to the vehicle but never tracked it (no valid position, 0 minutes): not performed
            G["ghost"] += 1; seen.add(k)
            ghosts[x["vehicle_ref"]].append(dict(kind="ghost", start=round(sched), end=round(sched) + 1, line=t["line"], sched=round(sched),
                                                 **({"auto": True} if t.get("auto") else {})))
            continue
        if not (ok(f) and ok(l)):
            f = l = None
        if f and l:
            # actual GPS: departure = first point (not before the scheduled time: waiting at the terminal is not driving),
            # arrival = last point of the ride; positions = where the bus really was
            G["gps"] += 1
            t0, t1 = max(mins(P(f[0])), sched), mins(P(l[0]))
            a, frm, ca = at([f[1], f[2]]); b, to, cb = at([l[1], l[2]])
            gkm = round(l[3] / 1000, 1) if l[3] is not None else None
            ride_min = mins(P(l[0])) - mins(P(f[0]))
            if gkm is not None and gkm > 2 and (ride_min <= 0 or gkm / (ride_min / 60) > 100):
                gkm = None  # SIRI's distance along the route is impossible for the time: not trusted
            done = True
            if t["d"]:
                long_enough = ride_min >= 0.5 * dur  # a loop route ends where it starts: being near the end is not enough
                done = (hav([l[1], l[2]], t["d"]) <= DONE_KM and long_enough) or (gkm is not None and bool(t["km_plan"]) and gkm >= DONE_SHARE * t["km_plan"])
            km = t["km_plan"] if done and t["km_plan"] is not None else gkm
            t.update(f_t=mins(P(f[0])), f_km=round(f[3] / 1000, 1) if f[3] is not None else None)
            t.update(start=round(t0), end=max(round(t1), round(t0) + 1), a=a, b=b, frm=frm, to=to, ca=ca, cb=cb, km=km, gps_km=gkm)
            if f[3] and f[3] > LATE_M and t["o"] and t["km_plan"] and dur > 0:
                # logged in mid-route (first GPS point already f[3] m along the route): the trip began at the route's first
                # stop, earlier by that distance at the route's planned speed
                t["g0"] = (t["start"], t["a"], t["frm"], t["ca"])  # the GPS start, if the estimate turns out impossible
                t0 = mins(P(f[0])) - f[3] / 1000 / (t["km_plan"] / dur)
                t.update(start=round(t0), a=[round(t["o"][0], 5), round(t["o"][1], 5)], frm=f'{t["o"][3]}, {t["o"][2]}', ca=t["o"][3],
                         late_login=round(f[3] / 1000, 1))
                G["late_login"] += 1
            if not done:
                t["incomplete"] = True; G["incomplete"] += 1
        else:
            # no GPS for this ride: planned route ends and times (marked no_gps)
            if not t["o"]:
                skipped += 1; continue
            G["no_gps"] += 1
            t.update(start=round(sched), end=round(sched + dur), a=[round(t["o"][0], 5), round(t["o"][1], 5)], b=[round(t["d"][0], 5), round(t["d"][1], 5)],
                     frm=f'{t["o"][3]}, {t["o"][2]}', to=f'{t["d"][3]}, {t["d"][2]}', ca=t["o"][3], cb=t["d"][3], km=t["km_plan"], no_gps=True,
                     **({"dur_est": True} if t.get("auto") and not x["duration_minutes"] else {}))
        seen.add(k)
        if t.get("auto"):
            auto_n += 1; auto_unmapped += 1 if t.get("unmapped") else 0
        t.update(sched=round(sched), cls=CL.get(t["mkt"], "לא ידוע"))
        by[x["vehicle_ref"]].append(t)

    vehicles = []; tot_day = 0; n_dup = 0
    for v, ts in sorted(by.items()):
        ts.sort(key=lambda t: (t.get("f_t", t["start"]), t["sched"]))  # in the order the GPS saw them
        ts, dups = merge_false_starts(ts); n_dup += len(dups); by[v] = ts
        snap_ends(ts)
        cls = collections.Counter(t["cls"] for t in ts if not t.get("auto")).most_common(1)
        cls = cls[0][0] if cls else ts[0]["cls"]
        items = []
        for i, t in enumerate(ts):
            if i:
                p = ts[i - 1]; gap = t["start"] - p["end"]
                term = (not p["to"].startswith(("ליד", "מיקום")), not t["frm"].startswith(("ליד", "מיקום")))  # snapped to a terminal stop
                km, mn, rt = road(p["b"], t["a"], term)
                leg = dict(kind="empty", start=p["end"], end=t["start"], km=km, drive_min=mn, frm=p["to"], to=t["frm"], next_sched=t["sched"],
                           a=p["b"], b=t["a"])
                if rt and (rt.get("fix") or rt.get("u") or max(rt.get("s") or [0]) > 30):
                    leg["rt"] = {x: rt[x] for x in ("s", "fix", "km0", "u", "ok") if x in rt}  # route check (assets/route.js)
                if rt and rt.get("fb"):
                    leg["fb"] = 1  # our bus OSRM failed: routed as a private car (public server), "חושב ברכב פרטי (גיבוי)"
                if km is None:  # OSRM failed: a marked estimate, never dropped
                    km = round(hav(p["b"], t["a"]) * 1.35, 1); leg.update(km=km, drive_min=round(km / 40 * 60, 1), est=True)
                if gap < 0:
                    leg["overlap"] = True   # SIRI shows two rides at once: data error, 0 empty km
                elif km > 2 and (leg["drive_min"] > gap + TIGHT_MIN or gap == 0 or km / (gap / 60) > 100):
                    leg["tight"] = True     # not enough time to drive it: data warning
                items.append(leg)
                if not leg.get("overlap"): tot_day += km
            items.append(dict(kind="trip", start=t["start"], end=t["end"], line=t["line"], km=t["km"], cls=t["cls"], sched=t["sched"],
                              frm=t["frm"], to=t["to"], a=t["a"], b=t["b"], ca=t["ca"], cb=t["cb"],
                              **{k: t[k] for k in ("auto", "line_ref", "unmapped", "dur_est", "incomplete", "gps_km", "km_plan", "no_gps", "late_login", "midroute",
                                           "snap_end", "snap_start", "trunc_end", "trunc_start")
                                 if t.get(k) is not None}))
        items += dups + ghosts.pop(v, [])
        # an empty leg sits right before the trip it leads to (also when SIRI shows overlapping rides)
        items.sort(key=lambda i: (i["end"] if i["kind"] == "empty" else i["start"], {"empty": 0, "ghost": 1, "dup": 1, "trip": 2}[i["kind"]]))
        f, l = ts[0], ts[-1]
        vehicles.append(dict(veh=v, cls=cls,
            first_o=[f["a"][0], f["a"][1], f["ca"]], last_d=[l["b"][0], l["b"][1], l["cb"]],
            service_km=round(sum(t["km"] or 0 for t in ts if not t.get("auto")), 1), items=items,
            empty_day_km=round(sum(i["km"] or 0 for i in items if i["kind"] == "empty" and not i.get("overlap")), 1)))

    # catalog of service routes (line + direction, planned terminals) seen this day, for marking reinforcement trips
    cat = {}
    for v, ts in by.items():
        for t in ts:
            if t.get("auto") or not t["o"]: continue
            k = (t["line"], t["o"][2], t["d"][2])
            c = cat.setdefault(k, dict(line=t["line"], frm=f'{t["o"][2]}, {t["o"][3]}', to=f'{t["d"][2]}, {t["d"][3]}',
                o=[round(t["o"][0], 5), round(t["o"][1], 5)], d=[round(t["d"][0], 5), round(t["d"][1], 5)],
                km=t["km_plan"], cls=t["cls"], durs=[]))
            if not t.get("incomplete"): c["durs"].append(t["end"] - t["start"])
    routes = []
    for c in cat.values():
        ds = c.pop("durs"); c["dur"] = round(statistics.median(ds)) if ds else round((c["km"] or 30) / 30 * 60); routes.append(c)
    routes.sort(key=lambda c: (c["line"].zfill(5), c["frm"]))
    save_osrm()

    n_empty = sum(1 for v in vehicles for i in v["items"] if i["kind"] == "empty")
    if not vehicles:
        raise SystemExit(f"{day}: no vehicles built")
    if n_empty and osrm_miss[0] > 0.2 * n_empty:
        raise SystemExit(f"{day}: OSRM failed for {osrm_miss[0]}/{n_empty} empty legs")

    n_fb = sum(1 for v in vehicles for i in v["items"] if i.get("fb"))
    out = dict(day=day, day_start_min=DAY_START_H * 60, routing=dict(profile=PROFILE, fallback_legs=n_fb), operator=OP["name"], operator_slug=OP["slug"], built=dt.datetime.now(TZ).isoformat(timespec="minutes"),
               routes=routes, summary=dict(vehicles=len(vehicles), trips=sum(len(v) for v in by.values()),
               empty_day_km=round(tot_day), skipped_rides=skipped, auto_rein=auto_n, auto_rein_unmapped=auto_unmapped,
               gps=G["gps"], no_gps=G["no_gps"], incomplete=G["incomplete"], false_starts=n_dup, not_performed=G["ghost"], late_login=G["late_login"],
               snap_end=sum(1 for v in by.values() for t in v if t.get("snap_end")), snap_start=sum(1 for v in by.values() for t in v if t.get("snap_start")),
               trunc_end=sum(1 for v in by.values() for t in v if t.get("trunc_end")), trunc_start=sum(1 for v in by.values() for t in v if t.get("trunc_start"))), vehicles=vehicles)
    os.makedirs(DATA, exist_ok=True)
    json.dump(out, open(os.path.join(DATA, f"day_{day}.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(json.dumps(out["summary"], ensure_ascii=False))


def decrypt_file(path):
    return json.loads(subprocess.run(["node", os.path.join(HERE, "decrypt.js"), KEY_FILE, path],
                                     check=True, capture_output=True).stdout.decode("utf-8"))


def ends_entry(v):
    """Compact record of one vehicle-day for the cross-day index (nights, idle days, branch)."""
    ts = [i for i in v["items"] if i["kind"] == "trip"]
    f, l = ts[0], ts[-1]
    return [f["start"], v["first_o"][0], v["first_o"][1], v["first_o"][2], f["frm"],
            l["end"], v["last_d"][0], v["last_d"][1], v["last_d"][2], l["to"], l["line"], v["cls"]]


def update_ends(day):
    """data/<slug>/ends_<YYYY-MM>.js: for every built day of the month, where and when each vehicle started and ended.
    Refreshed from every day file whose content changed, so it always matches the current day files."""
    month = day[:7]
    name = f"ends_{month}"
    ef = os.path.join(DATA, name + ".js")
    idx = decrypt_file(ef) if os.path.exists(ef) else {"days": {}, "ver": {}}
    for f in sorted(glob.glob(os.path.join(DATA, f"day_{month}-*.js"))):
        d = os.path.basename(f)[4:14]
        h = hashlib.sha256(open(f, "rb").read()).hexdigest()[:10]
        if idx["ver"].get(d) == h: continue
        jf = os.path.join(DATA, f"day_{d}.json")
        J = json.load(open(jf, encoding="utf-8")) if d == day and os.path.exists(jf) else decrypt_file(f)
        idx["days"][d] = {v["veh"]: ends_entry(v) for v in J["vehicles"]}
        idx["ver"][d] = h
    json.dump(idx, open(os.path.join(DATA, name + ".json"), "w", encoding="utf-8"), ensure_ascii=False)
    subprocess.run(["node", os.path.join(HERE, "encrypt.js"), KEY_FILE, DATA, name], check=True)
    print("ends index", month, "days:", len(idx["days"]))


def encrypt(day):
    subprocess.run(["node", os.path.join(HERE, "encrypt.js"), KEY_FILE, DATA, day], check=True)
    update_ends(day)
    write_days_index()


def write_days_index():
    """data/<slug>/days.js: built days + a short content hash per day/ends file (cache-busting ?v=)."""
    files = sorted(glob.glob(os.path.join(DATA, "day_*.js")))
    h = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()[:10]
    days = [os.path.basename(f)[4:14] for f in files]
    ver = {os.path.basename(f)[4:14]: h(f) for f in files}
    ends = {os.path.basename(f)[5:12]: h(f) for f in sorted(glob.glob(os.path.join(DATA, "ends_*.js")))}
    meta = dict(days=days, day_start_hour=DAY_START_H, name=OP["name"], ver=ver, ends=ends)
    open(os.path.join(DATA, "days.js"), "w", encoding="utf-8").write(
        f"(window.OPDAYS=window.OPDAYS||{{}})[{json.dumps(OP['slug'])}]=" + json.dumps(meta, ensure_ascii=False) + ";\n")
    print("days:", days)


def main():
    global OP, DATA, KEY_FILE, DAY_START_H
    args = sys.argv[1:]
    slug = "derech-egged"
    if "--op" in args:
        i = args.index("--op"); slug = args[i + 1]; del args[i:i + 2]
    OP = operator(slug)
    DAY_START_H = OP["service_day_start_hour"]
    DATA = os.path.join(REPO, "data", slug)
    if args == ["--reindex"]:  # only rewrite days.js (after pipeline/rotate_key.js re-encrypted the files)
        return write_days_index()
    day = args[0]
    dt.date.fromisoformat(day)
    KEY_FILE = os.environ.get("DATA_KEY_FILE") or os.path.join(REPO, "config", f".data_key_{slug}")
    if not os.path.exists(KEY_FILE):
        raise SystemExit("missing data key: " + KEY_FILE)
    build(day)
    encrypt(day)


if __name__ == "__main__":
    main()
