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
from stride import TZ, operator, fetch_rides, update_route_ends, fetch_locations, fetch_traces, fetch_gtfs_rides

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
SNAP = dict(dict(enabled=True, share=0.95, max_km=1.0, before_tol_km=0.0, start_share=0.05, start_max_km=1.0, next_at_stop_km=0.3),
            **json.load(open(os.path.join(HERE, "config.json"), encoding="utf-8")).get("gps_end_snap", {}))
if os.environ.get("GPS_END_SNAP") == "0": SNAP["enabled"] = False
# An empty leg that starts (ends) at a raw GPS point on the road (not a stop) is routed in the bus's direction of travel:
# the SIRI heading of the last (first) point goes to OSRM as a bearing, so the leg leaves on the carriageway the bus was
# on (David, 18.11.2026: line 137 lost on Golda Meir southbound was routed from the northbound side, 4.79 km instead of
# ~1.2). pipeline/config.json "gps_heading"; GPS_HEADING=0 turns it off.
HEAD = dict(dict(enabled=True, tol_deg=60, radius_m=15, line_m=60, shape_m=150, trace_n=2, trace_min_m=30),
            **json.load(open(os.path.join(HERE, "config.json"), encoding="utf-8")).get("gps_heading", {}))
if os.environ.get("GPS_HEADING") == "0": HEAD["enabled"] = False
# The line's road = the licensed shape of the ride (MOT GTFS of that day, pipeline/gtfs_shapes.py -> cache/gtfs_shapes_<slug>_<day>.json,
# else cache/gtfs_shapes_<slug>.json; David,
# 18.11.2026). Without that file: OSRM between the two licensed stops around the point, checked against the ride's own
# GPS trace (cache/trace_<slug>_<day>.json, stride.fetch_traces). GPS_TRACES=0: no traces (no Stride calls for them).
SHAPES = {}
SHC = {}
# Shape guard (David, 18.11.2026): an empty leg leaving from a GPS point on the line's road towards the line's last stop
# (next start within near_km of it) that is >= ratio x and >= min_km longer than the rest of the shape is routed along the
# shape instead; when that cannot be done the build fails (no file is written). No warning in the dashboard.
SHAPE_GUARD = dict(dict(ratio=1.5, min_km=1.0, near_km=0.4),
                   **json.load(open(os.path.join(HERE, "config.json"), encoding="utf-8")).get("shape_guard", {}))
SHAPE_GUARD_FAIL = []
# Route deviation ("סטייה מהמסלול ברישוי"): the ride's own GPS points farther than m from its licensed shape over more than
# run_m of driving, between points on the shape (David, 18.11.2026; threshold not decided yet: 150/250/400, running with 250).
# pipeline/config.json "route_dev"; ROUTE_DEV=0 turns it off.
DEV = dict(dict(enabled=True, m=250, run_m=500),
           **json.load(open(os.path.join(HERE, "config.json"), encoding="utf-8")).get("route_dev", {}))
if os.environ.get("ROUTE_DEV") == "0": DEV["enabled"] = False
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

    def ask(p, q, term, h=(None, None)):
        if proc[0] is None:
            proc[0] = subprocess.Popen(["node", os.path.join(HERE, "route.js")], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       text=True, encoding="utf-8", bufsize=1)
        req = dict(a=p, b=q, t=term)
        if h[0] is not None or h[1] is not None: req.update(h=list(h), tol=HEAD["tol_deg"], rad=HEAD["radius_m"])
        proc[0].stdin.write(json.dumps(req) + "\n"); proc[0].stdin.flush()
        return json.loads(proc[0].stdout.readline() or "null")

    def road(p, q, term=(True, True), h=(None, None)):
        """-> (km, min, meta) ; meta = {s:[snap m], fix?, km0?, via?, u?, ok?, why?} ; (None, None, None) when OSRM failed."""
        if hav(p, q) < 0.05:
            return 0.0, 0.0, None
        k = f"{p[0]:.5f},{p[1]:.5f};{q[0]:.5f},{q[1]:.5f}"  # same rounding as the browser's road_cache key
        if h[0] is not None or h[1] is not None:  # routed in the bus's direction: its own entry (heading in 10 degree steps)
            h = tuple(None if x is None else int(round(x / 10.0)) * 10 % 360 for x in h)
            k += "|h" + ",".join("" if x is None else str(x) for x in h) + f'|r{HEAD["radius_m"]}'
        c = cache.get(k)
        if not c or len(c) < 3 or (c[2] or {}).get("v", 0) < ROUTE_V or (c[2] or {}).get("p", "car") != PROFILE or (c[2] or {}).get("fb"):
            r = ask([round(p[0], 5), round(p[1], 5)], [round(q[0], 5), round(q[1], 5)], list(term), h)
            if not r:
                miss[0] += 1
                return None, None, None
            old = c[0] if c else None
            meta = {x: r[x] for x in ("v", "s", "fix", "km0", "via", "u", "ok", "why", "p", "fb", "hd") if x in r}
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

    def geom(p, q):
        """The road between two stops of a line as [[lat, lon], ...] (cached), None when OSRM has none."""
        k = f"g|{p[0]:.5f},{p[1]:.5f};{q[0]:.5f},{q[1]:.5f}"
        if k not in cache:
            if proc[0] is None: ask(p, q, [True, True])  # start the router process
            proc[0].stdin.write(json.dumps(dict(a=p, b=q, g=1)) + "\n"); proc[0].stdin.flush()
            r = json.loads(proc[0].stdout.readline() or "null"); cache[k] = [r["km"], r["g"]] if r else None
            stat["geom"] += 1
        return cache[k]

    def geomp(pts, hs, key):
        """The road through points of a licensed shape, each in its direction (cached under key)."""
        if key not in cache:
            if proc[0] is None: ask(pts[0], pts[-1], [True, True])  # start the router process
            proc[0].stdin.write(json.dumps(dict(g=1, p=pts, h=hs, rad=25)) + "\n"); proc[0].stdin.flush()
            r = json.loads(proc[0].stdout.readline() or "null"); cache[key] = [r["km"], r["g"]] if r else None
            stat["geom"] += 1
        return cache[key]

    def save():
        if proc[0] is not None:
            proc[0].stdin.close(); proc[0].wait(); proc[0] = None
        json.dump(cache, open(cache_file, "w", encoding="utf-8"))
        if stat: print("routes:", dict(stat))

    road.geom = geom; road.geomp = geomp
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
            m = dict(keep, start=p["start"], a=p["a"], frm=p["frm"], ca=p["ca"], end=t["end"], b=t["b"], to=t["to"], cb=t["cb"], ha=p.get("ha"), hb=t.get("hb"),
                     gps_raw_a=p.get("gps_raw_a"), gps_raw_b=t.get("gps_raw_b"), rid_a=p.get("rid_a"), rid_b=t.get("rid_b"),
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
                t.update(start=p["start"], a=p["a"], frm=p["frm"], ca=p["ca"], ha=p.get("ha"), gps_raw_a=p.get("gps_raw_a"), f_km=p.get("f_km"), rid_a=p.get("rid_a")); t.pop("late_login", None)
                out[-1] = t
                continue
        out.append(t)
    return out, dups


RAW = ("ליד", "מיקום")


def brg(a, b):
    y = math.sin(math.radians(b[1] - a[1])) * math.cos(math.radians(b[0]))
    x = math.cos(math.radians(a[0])) * math.sin(math.radians(b[0])) - math.sin(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.cos(math.radians(b[1] - a[1]))
    return round(math.degrees(math.atan2(y, x))) % 360


TRACE = {}


def near(t, pos, end):
    """The ride's own GPS points just before its last point (end=1) / just after its first (end=0): up to trace_n, each at
    least trace_min_m away from pos, nearest first."""
    tr = TRACE.get(t.get("rid_b" if end else "rid_a")) or []
    seq = reversed(tr) if end else tr
    out = []
    for x in seq:
        q = [x[1], x[2]]
        if hav(q, pos) * 1000 < HEAD["trace_min_m"] or hav(q, pos) > 2: continue
        out.append(q)
        if len(out) >= HEAD["trace_n"]: break
    return out


def trace_heading(t, end):
    """Direction of travel at a GPS end (start) from the ride's own previous (next) point, or None."""
    pos = t.get("gps_raw_b" if end else "gps_raw_a"); n = near(t, pos, end) if pos else []
    if not n: return None
    return brg(n[0], pos) if end else brg(pos, n[0])


def proj(pos, a, b):
    """(metres from pos to segment a-b, the nearest point, share along the segment)."""
    k = math.cos(math.radians(pos[0]))
    ax, ay, bx, by = a[1] * k, a[0], b[1] * k, b[0]; px, py = pos[1] * k, pos[0]
    dx, dy = bx - ax, by - ay; u = 0 if dx == dy == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    q = [ay + u * dy, (ax + u * dx) / k]
    return hav(pos, q) * 1000, q, u


def shape(sid):
    """A licensed shape: (points, metres along it at each point)."""
    if sid not in SHC:
        pts = SHAPES["shapes"][sid]; cum = [0.0]
        for i in range(1, len(pts)): cum.append(cum[-1] + hav(pts[i - 1], pts[i]) * 1000)
        SHC[sid] = (pts, cum)
    return SHC[sid]


def on_shape(sid, pos, target):
    """pos on the shape: (m off, point, m along, direction), the candidate within shape_m nearest to target m along (a route
    that passes the same street twice), or the nearest one when target is None; None when none is within shape_m."""
    pts, cum = shape(sid); cands = []
    for j in range(len(pts) - 1):
        d, q, u = proj(pos, pts[j], pts[j + 1])
        if d > HEAD["shape_m"]: continue
        cands.append((d, q, cum[j] + u * (cum[j + 1] - cum[j]), brg(pts[j], pts[j + 1]) if cum[j + 1] - cum[j] > 3 else None))
    if not cands: return None
    d0 = min(c[0] for c in cands)
    # the nearest place on the shape; only when the shape passes about as near again (within 30 m more, 300 m or more
    # along it away: the same street twice) does the distance GPS says the bus had covered decide between them
    near = [c for c in cands if c[0] <= d0 + 30]
    far_apart = target is not None and max(c[2] for c in near) - min(c[2] for c in near) > 300
    return min(near, key=lambda c: (abs(c[2] - target), c[0])) if far_apart else min(cands, key=lambda c: c[0])


def at_m(sid, m):
    """The shape's point and direction m metres along it."""
    pts, cum = shape(sid); m = max(0, min(m, cum[-1]))
    j = max(0, min(len(pts) - 2, next((i for i in range(len(cum) - 1) if cum[i + 1] >= m), len(pts) - 2)))
    while j < len(pts) - 2 and cum[j + 1] - cum[j] < 0.5: j += 1
    u = 0 if cum[j + 1] == cum[j] else (m - cum[j]) / (cum[j + 1] - cum[j])
    a, b = pts[j], pts[j + 1]
    return [round(a[0] + u * (b[0] - a[0]), 6), round(a[1] + u * (b[1] - a[1]), 6)], brg(a, b)


def on_road(g, q):
    """q onto an OSRM polyline: (m off, point, direction there)."""
    best = None
    for j in range(len(g) - 1):
        d, p, _ = proj(q, g[j], g[j + 1])
        if best is None or d < best[0]: best = (d, p, brg(g[j], g[j + 1]) if hav(g[j], g[j + 1]) > 0.003 else None)
    return best


def shape_grid(sid):
    """Segments of a shape by ~220 m cell, for distance queries."""
    k = ("grid", sid)
    if k not in SHC:
        pts, _ = shape(sid); g = collections.defaultdict(list)
        for j in range(len(pts) - 1):
            a, b = pts[j], pts[j + 1]
            for cy in range(int(min(a[0], b[0]) / .002), int(max(a[0], b[0]) / .002) + 1):
                for cx in range(int(min(a[1], b[1]) / .002), int(max(a[1], b[1]) / .002) + 1):
                    g[(cy, cx)].append(j)
        SHC[k] = g
    return SHC[k]


def off_shape(sid, q, lim):
    """Metres from q to the shape, capped: anything beyond lim (and beyond ~2 cells) is reported as lim + 1."""
    pts, _ = shape(sid); g = shape_grid(sid); r = int(lim / 200) + 1
    cy, cx = int(q[0] / .002), int(q[1] / .002); seen = set(); best = lim + 1
    for y in range(cy - r, cy + r + 1):
        for x in range(cx - r, cx + r + 1):
            for j in g.get((y, x), ()):
                if j in seen: continue
                seen.add(j); d = proj(q, pts[j], pts[j + 1])[0]
                if d < best: best = d
    return best


def route_dev(sid, tr, m=None, run_m=None):
    """GPS points of a ride off its licensed shape: [max m off, km driven off the shape, number of places] or None.
    A place counts when the points farther than m from the shape run over more than run_m of driving and the bus is
    back on the shape after it (a trip lost before its end is "קטיעה", not a deviation)."""
    m = m or DEV["m"]; run_m = run_m or DEV["run_m"]
    if not sid or sid not in SHAPES.get("shapes", {}) or not tr or len(tr) < 3: return None
    # from the first point along the journey (before it SIRI may send the bus's position at the depot, or jumps); a point
    # that would need > 120 km/h from the previous kept one is a GPS jump, not driving
    k = next((i for i, x in enumerate(tr) if x[3]), None)
    if k is None: return None
    T = lambda x: dt.datetime.fromisoformat(x[0]).timestamp(); kept = [tr[k]]
    for x in tr[k + 1:]:
        h = max((T(x) - T(kept[-1])) / 3600, 1 / 3600)
        if hav(kept[-1][1:3], x[1:3]) / h <= 120: kept.append(x)
    tr = kept
    if len(tr) < 3: return None
    d = [off_shape(sid, [x[1], x[2]], max(m, 400)) for x in tr]
    on = [z <= m for z in d]
    first = next((i for i, o in enumerate(on) if o), None)
    if first is None: return None
    out = []; i = first
    while i < len(tr):
        if on[i]: i += 1; continue
        j = i
        while j < len(tr) and not on[j]: j += 1
        if j >= len(tr): break  # not back on the shape: the end of the ride, not a deviation
        p = lambda k: [tr[k][1], tr[k][2]]
        run = hav(p(i - 1), p(i)) / 2 + sum(hav(p(k), p(k + 1)) for k in range(i, j - 1)) + hav(p(j - 1), p(j)) / 2
        if run * 1000 > run_m: out.append((max(d[i:j]), run))
        i = j
    if not out: return None
    return [round(min(max(x[0] for x in out), 999)), round(sum(x[1] for x in out), 1), len(out)]


def own_gtfs(raw, day, LOC):
    """Our own SIRI -> GTFS link (David, 18.11.2026: the whole system follows the MOT GTFS of that day). The licensed trips of
    service day D (GTFS dates D and D+1, 04:00..04:00 local, from Stride's import of that day's MOT GTFS) are matched to the
    SIRI rides of the same route (line_ref): first the rides whose scheduled departure is that trip's minute, then within 10
    minutes. One licensed trip per ride and one ride per licensed trip: when two buses claim one trip, the trip goes to the bus
    Stride linked to it when Stride linked only one of them (trip number, any date: after the 08.11 date fix); otherwise to the
    bus whose first GPS point is nearest the trip's departure, on a tie the one that left first (David, 18.11.2026). The other
    bus is a reinforcement trip, like a second departure of the line. Two licensed trips at that minute = two licensed rides.
    Stride's link is replaced when it differs (08.11.2026: 1,626 rides tied to the 09.11 trips), added when Stride has none
    (15.11.2026: 28 night trips after midnight), and removed when no licensed trip is left for the ride. Returns counts."""
    a = dt.datetime.combine(dt.date.fromisoformat(day), dt.time(DAY_START_H), TZ); b = a + dt.timedelta(days=1)
    L = []
    for d in (day, (dt.date.fromisoformat(day) + dt.timedelta(days=1)).isoformat()):
        L += fetch_gtfs_rides(d, OP["operator_ref"], os.path.join(CACHE_DIR, f"gtfs_rides_{OP['slug']}_{d}.json"))
    P = dt.datetime.fromisoformat
    L = [x for x in L if a <= P(x["start_time"]) < b]
    if not L: return {}
    by = collections.defaultdict(list)
    for x in L: by[x["line_ref"]].append(x)
    def dep(r):  # actual departure: the first GPS point, else the scheduled time
        f = LOC.get(str(r.get("first_vehicle_location_id")))
        try: return P(f[0]) if f and f[1] and IL[0] < f[1] < IL[1] else P(r["scheduled_start_time"])
        except Exception: return P(r["scheduled_start_time"])
    seen, rides = set(), []
    for r in raw:  # one SIRI ride per (vehicle, scheduled start), as build() reads them
        k = (r["vehicle_ref"], r["scheduled_start_time"])
        if r["vehicle_ref"] and k not in seen: seen.add(k); rides.append(r)
    cand = []
    for r in rides:
        t, d0 = P(r["scheduled_start_time"]), dep(r)
        for x in by.get(r["siri_route__line_ref"], []):
            dt_s = abs((P(x["start_time"]) - t).total_seconds())
            if dt_s <= 600:
                cand.append([0 if dt_s == 0 else 1, 0, abs((d0 - P(x["start_time"])).total_seconds()), d0, r["id"], x["id"], r, x])
    sk = lambda r, x: (r["gtfs_ride__journey_ref"] or "").split("_")[0] == x["journey_ref"].split("_")[0] and r["gtfs_ride__start_time"]         and P(r["gtfs_ride__start_time"]).astimezone(TZ).time() == P(x["start_time"]).astimezone(TZ).time()  # Stride's link (any date)
    claim = collections.defaultdict(set); slink = collections.defaultdict(set)
    for c in cand:
        if c[0] == 0: claim[c[5]].add(c[4])  # buses scheduled at that very minute
        if sk(c[6], c[7]): slink[c[5]].add(c[4])
    for c in cand:
        if len(slink[c[5]]) == 1 and c[4] in slink[c[5]]: c[1] = -1  # the only bus Stride linked to this trip goes first
    cand.sort(key=lambda c: c[:6])
    used, got = set(), {}
    n = collections.Counter()
    for c in cand:
        if c[4] in got or c[5] in used: continue
        got[c[4]] = c[7]; used.add(c[5])
    for tid, rs in claim.items():
        if len(rs) > 1 and tid in used:  # two (or more) buses at one licensed trip's minute
            n["two_buses"] += 1
            n["two_buses_both_licensed" if sum(1 for r in rs if r in got) == len(rs) else
              "two_buses_by_stride" if len(slink[tid] & rs) == 1 else "two_buses_by_rule"] += 1
    n.update(licensed=len(L), matched=len(got), not_run=len(L) - len(used))
    trip_rides = collections.Counter((r["gtfs_ride__journey_ref"] or "").split("_")[0] + "|" + str(r["gtfs_ride__start_time"]) for r in rides if r["gtfs_ride_id"])
    for r in rides:
        x = got.get(r["id"])
        if not x:
            if r["gtfs_ride_id"]:
                two = trip_rides[(r["gtfs_ride__journey_ref"] or "").split("_")[0] + "|" + str(r["gtfs_ride__start_time"])] > 1
                n["to_rein_second_bus" if two else "to_rein_no_trip"] += 1
                for k in [k for k in r if k.startswith(("gtfs_ride", "gtfs_route"))]: r[k] = None
                r["gtfs_ride_id"] = None; r["own_gtfs"] = "rein"
            continue
        if r["gtfs_ride_id"] and r["gtfs_ride__start_time"] and P(r["gtfs_ride__start_time"]) == P(x["start_time"])                 and (r["gtfs_ride__journey_ref"] or "").split("_")[0] == x["journey_ref"].split("_")[0]:
            if trip_rides[x["journey_ref"].split("_")[0] + "|" + str(r["gtfs_ride__start_time"])] > 1: n["kept_second_bus"] += 1
            continue
        n["added" if not r["gtfs_ride_id"] else "other_date" if abs((P(r["gtfs_ride__start_time"]) - P(x["start_time"])).total_seconds()) >= 43200 else "relinked"] += 1
        r.update(gtfs_ride_id=x["id"], gtfs_ride__gtfs_route_id=x["route_id"], gtfs_ride__journey_ref=x["journey_ref"],
                 gtfs_ride__start_time=x["start_time"], gtfs_ride__end_time=x["end_time"], gtfs_route__line_ref=x["line_ref"],
                 gtfs_route__route_short_name=x["short"], gtfs_route__route_mkt=x["mkt"], gtfs_route__route_direction=x["dir"],
                 gtfs_route__route_alternative=x["alt"], own_gtfs=1)
    return dict(n)


def on_line(road, t, pos, along_km, end):
    """A raw GPS end (start) of a ride -> (point on the line's own road, that road's direction there, metres moved), or None.
    The line's road is the ride's licensed shape (MOT GTFS): the point goes to the shape where it is <= line_m away, or
    <= shape_m away when the ride's own previous (next) GPS points are on the shape too (the bus was on the line's road just
    before it was lost: David, 18.11.2026, line 137 on Golda Meir next to Begin). The place on the shape is the one nearest to
    the distance GPS says the bus had covered (a route that passes a street twice). The road there is OSRM through shape
    points around it, each in the shape's direction, so the empty leg leaves on the line's carriageway.
    Without a shape: OSRM between the two licensed stops around the point (<= 1.3 x their planned distance + 0.2 km),
    used only when the ride's own previous (next) GPS points are on it too."""
    if pos is None: return None
    sid = t.get("shp")
    if sid and sid in SHAPES.get("shapes", {}):
        pts, cum = shape(sid)
        tg = along_km * 1000 * cum[-1] / (t["km_plan"] * 1000) if along_km is not None and t.get("km_plan") else None
        c = on_shape(sid, pos, tg)
        if not c: return None
        d, q, m, h = c
        if d > HEAD["line_m"]:
            n = near(t, pos, end)
            if not n or any((lambda z: not z or z[0] > HEAD["line_m"])(on_shape(sid, x, None)) for x in n): return None
        lo, hi = (m - 600, m + 150) if end else (m - 150, m + 600)
        lo, hi = max(lo, 0), min(hi, cum[-1])
        marks = sorted({round(lo), round(hi), round(m)} | set(range(int(lo // 150 + 1) * 150, int(hi), 150)))
        marks = [x for i, x in enumerate(marks) if i == 0 or x - marks[i - 1] >= 40 or x == round(m)]
        way = [at_m(sid, x) for x in marks]
        g = road.geomp([w[0] for w in way], [w[1] for w in way], f"gs|{sid}|{marks[0]}|{marks[-1]}|{round(m)}")
        if g and len(g[1]) >= 2 and g[0] <= (hi - lo) / 1000 * 1.3 + 0.2:
            r = on_road(g[1], q)
            if r and r[0] <= 30 and r[2] is not None:
                return [round(r[1][0], 6), round(r[1][1], 6)], r[2], round(hav(pos, r[1]) * 1000), cum[-1] - m
        return ([round(q[0], 6), round(q[1], 6)], h, round(d), cum[-1] - m) if h is not None else None
    st = t.get("st")
    if not st or len(st) < 2 or pos is None: return None
    m = along_km * 1000
    i = next((k for k in range(len(st) - 1) if st[k][2] <= m <= st[k + 1][2]), None)
    if i is None: i = 0 if m < st[0][2] else len(st) - 2
    g = road.geom(st[i][:2], st[i + 1][:2])
    if not g or g[0] > (st[i + 1][2] - st[i][2]) / 1000 * 1.3 + 0.2 or len(g[1]) < 2: return None
    k = math.cos(math.radians(pos[0])); best = None
    for j in range(len(g[1]) - 1):
        a, b = g[1][j], g[1][j + 1]
        ax, ay, bx, by = a[1] * k, a[0], b[1] * k, b[0]; px, py = pos[1] * k, pos[0]
        dx, dy = bx - ax, by - ay; u = 0 if dx == dy == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        q = [ay + u * dy, (ax + u * dx) / k]; d = hav(pos, q) * 1000
        if best is None or d < best[0]: best = (d, q, brg(a, b) if hav(a, b) > 0.003 else None)
    if best[0] > HEAD["line_m"] or best[2] is None: return None
    n = near(t, pos, end)
    if TRACE and n and any(on_road(g[1], x)[0] > HEAD["line_m"] for x in n): return None  # the bus was not on this road
    return [round(best[1][0], 6), round(best[1][1], 6)], best[2], round(best[0])


def snap_ends(ts):
    """Move a GPS trip end (start) that is a raw point to the planned last (first) stop under the strict rule (SNAP).
    Runs on one vehicle's trips in order, after merge_false_starts: the next/previous trip is the next/previous event."""
    if not SNAP["enabled"]: return
    for i, t in enumerate(ts):
        if t.get("no_gps") or not t.get("km_plan") or not t.get("dur"): continue
        v = t["km_plan"] / t["dur"]  # planned km per minute
        g = t.get("gps_km")
        rb = t.get("gps_raw_b") or t["b"]
        if t["d"] and (t["to"].startswith(RAW) or hav(rb, t["d"]) > SNAP_KM):  # a raw point, or another stop than the planned one
            d, why = t["d"], []
            if g is None or g < SNAP["share"] * t["km_plan"]: why.append("share")
            if hav(rb, d) > SNAP["max_km"] or (g is not None and g > t["km_plan"] + SNAP["before_tol_km"]): why.append("far")
            nx = ts[i + 1] if i + 1 < len(ts) else None
            if nx is not None and g is not None and nx["start"] - t["end"] < max(t["km_plan"] - g, 0) / v: why.append("time")
            if why:
                t["trunc_end"] = why
                if t.get("incomplete") and nx is not None and hav(d, nx["a"]) <= SNAP["next_at_stop_km"]:
                    # GPS lost it early, but the bus's next trip leaves from this trip's planned last stop: it got there, so the trip
                    # counts as completed (planned km) and ends at that stop (David, 18.11.2026; group "א" of the 157 checked)
                    t.pop("incomplete", None); t["km"] = t["km_plan"]; t["done_next"] = 1
                if not t.get("incomplete"):
                    # counted as completed (km = the planned km): the empty leg leaves from the planned last stop, as if the bus
                    # had driven the rest (David, 18.11.2026); the trip stays marked "קטיעה אפשרית" with where GPS ended
                    t.update(trunc_to=t["to"], b=[round(d[0], 5), round(d[1], 5)], to=f'{d[3]}, {d[2]}', cb=d[3])
            else:
                t["snap_end"] = dict(b=t["b"], to=t["to"], m=round(hav(rb, d) * 1000))
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
    LOC = fetch_locations(raw, os.path.join(CACHE_DIR, f"vloc_{OP['slug']}_{day}.json"))
    gm = own_gtfs(raw, day, LOC) if os.environ.get("OWN_GTFS") != "0" else {}
    print("own GTFS link:", gm, file=sys.stderr)
    ends = update_route_ends(raw, os.path.join(CACHE_DIR, "route_ends.json"))
    global TRACE
    TRACE = {} if os.environ.get("GPS_TRACES") == "0" or not HEAD["enabled"] else fetch_traces(raw, os.path.join(CACHE_DIR, f"trace_{OP['slug']}_{day}.json"))
    sf = os.path.join(CACHE_DIR, f"gtfs_shapes_{OP['slug']}_{day}.json")  # that day's GTFS (routes change: 152/154/160 in 11.2026)
    if not os.path.exists(sf): sf = os.path.join(CACHE_DIR, f"gtfs_shapes_{OP['slug']}.json")  # else the latest one
    SHAPES.clear(); SHC.clear()
    if HEAD["enabled"] and os.path.exists(sf): SHAPES.update(json.load(open(sf, encoding="utf-8")))
    print("line shapes:", f"{len(SHAPES.get('shapes', {}))} (GTFS {SHAPES.get('gtfs_date')})" if SHAPES else "none (OSRM between stops)",
          "· traces:", len(TRACE), file=sys.stderr)
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
            t = dict(line=x["gtfs_route__route_short_name"], mkt=x["gtfs_route__route_mkt"], o=e["o"], d=e["d"], km_plan=round(e["km"], 1), st=e.get("st"),
                     shp=SHAPES.get("trips", {}).get((x["gtfs_ride__journey_ref"] or "").split("_")[0])
                     or (SHAPES.get("routes", {}).get(str(x["gtfs_route__line_ref"])) or [None])[0])
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
            t.update(gps_raw_a=[f[1], f[2]], gps_raw_b=[l[1], l[2]], rid_a=str(x["id"]), rid_b=str(x["id"]))
            if DEV["enabled"]:
                dv = route_dev(t.get("shp"), TRACE.get(str(x["id"])))
                if dv: t["dev"] = dv  # [max m off the licensed shape, km off it, places]
            gkm = round(l[3] / 1000, 1) if l[3] is not None else None
            ride_min = mins(P(l[0])) - mins(P(f[0]))
            if gkm is not None and gkm > 2 and (ride_min <= 0 or gkm / (ride_min / 60) > 100):
                gkm = None  # SIRI's distance along the route is impossible for the time: not trusted
            done = True
            if t["d"]:
                long_enough = ride_min >= 0.5 * dur  # a loop route ends where it starts: being near the end is not enough
                done = (hav([l[1], l[2]], t["d"]) <= DONE_KM and long_enough) or (gkm is not None and bool(t["km_plan"]) and gkm >= DONE_SHARE * t["km_plan"])
            km = t["km_plan"] if done and t["km_plan"] is not None else gkm
            t.update(f_t=mins(P(f[0])), f_km=round(f[3] / 1000, 1) if f[3] is not None else None,
                     ha=f[4] if len(f) > 4 and f[4] else None, hb=l[4] if len(l) > 4 and l[4] else None)  # 0 = SIRI "unknown"
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
                hd = (None if term[0] or not HEAD["enabled"] else p.get("hb"), None if term[1] or not HEAD["enabled"] else t.get("ha"))
                A, B, lr, rest = p["b"], t["a"], [None, None], None
                if HEAD["enabled"] and not term[0] and p.get("gps_raw_b"):
                    s = on_line(road, p, p["gps_raw_b"], p.get("gps_km"), 1)
                    if s: A, hd, lr[0], rest = s[0], (s[1], hd[1]), s[2], (s[3] if len(s) > 3 else None)
                    elif trace_heading(p, 1) is not None: hd = (trace_heading(p, 1), hd[1])
                if HEAD["enabled"] and not term[1] and t.get("gps_raw_a") and not t.get("late_login"):
                    s = on_line(road, t, t["gps_raw_a"], t.get("f_km"), 0)
                    if s: B, hd, lr[1] = s[0], (hd[0], s[1]), s[2]
                    elif trace_heading(t, 0) is not None: hd = (hd[0], trace_heading(t, 0))
                km, mn, rt = road(A, B, term, hd)
                sg = None
                if rest is not None and km is not None and p.get("d") and hav(p["d"], B) <= SHAPE_GUARD["near_km"]:
                    # safety net: an empty leg from the point on the line's road to (near) the line's last stop must not be much
                    # longer than the rest of the line's shape (OSRM snapping to a ramp: 4.58 km instead of 1.02 on Golda Meir)
                    base = rest / 1000 + hav(p["d"], B)
                    if km >= SHAPE_GUARD["ratio"] * base and km - base >= SHAPE_GUARD["min_km"]:
                        k2, m2, _ = road([round(p["d"][0], 5), round(p["d"][1], 5)], B, (True, term[1]), (None, hd[1]))
                        if k2 is None: SHAPE_GUARD_FAIL.append(f'{p["line"]} {v} {p["end"]}: {km} km vs shape {base:.2f}')
                        else: sg, km, mn = km, round(rest / 1000 + k2, 2), round(rest / 1000 / 30 * 60 + m2, 1)
                leg = dict(kind="empty", start=p["end"], end=t["start"], km=km, drive_min=mn, frm=p["to"], to=t["frm"], next_sched=t["sched"],
                           a=p["b"], b=t["a"])
                if rt and (rt.get("fix") or rt.get("u") or max(rt.get("s") or [0]) > 30):
                    leg["rt"] = {x: rt[x] for x in ("s", "fix", "km0", "u", "ok") if x in rt}  # route check (assets/route.js)
                if rt and rt.get("hd"):
                    leg["hd"] = rt["hd"]  # routed in the bus's direction of travel ([heading at a, heading at b])
                if sg is not None:
                    leg["sg"] = sg  # km before the shape guard: now along the rest of the line's shape to its last stop, then on
                if any(x is not None for x in lr):
                    leg["lr"] = lr  # [m from the GPS point to the line's road at a, at b]: routed from the point on the line's road
                    leg["la"] = [A if lr[0] is not None else None, B if lr[1] is not None else None]  # those points on the line's road
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
                                           "snap_end", "snap_start", "trunc_end", "trunc_start", "trunc_to", "done_next", "dev")
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
               empty_day_km=round(sum(v["empty_day_km"] for v in vehicles)),  # the vehicles' own (0.1 km) sums: the day = what the vehicles show
               skipped_rides=skipped, auto_rein=auto_n, auto_rein_unmapped=auto_unmapped,
               gps=G["gps"], no_gps=G["no_gps"], incomplete=sum(1 for v in by.values() for t in v if t.get("incomplete")), done_next=sum(1 for v in by.values() for t in v if t.get("done_next")), false_starts=n_dup, not_performed=G["ghost"], late_login=G["late_login"],
               snap_end=sum(1 for v in by.values() for t in v if t.get("snap_end")), snap_start=sum(1 for v in by.values() for t in v if t.get("snap_start")),
               trunc_end=sum(1 for v in by.values() for t in v if t.get("trunc_end")), trunc_start=sum(1 for v in by.values() for t in v if t.get("trunc_start")),
               route_dev=sum(1 for v in by.values() for t in v if t.get("dev")), gtfs_link=gm), vehicles=vehicles)
    out["summary"]["shape_guard"] = sum(1 for v in vehicles for i in v["items"] if i.get("sg") is not None)
    if SHAPE_GUARD_FAIL:
        raise SystemExit(f"shape guard failed ({len(SHAPE_GUARD_FAIL)}): " + "; ".join(SHAPE_GUARD_FAIL[:10]))
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
