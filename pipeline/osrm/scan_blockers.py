"""Every OSM way / node the bus-strict profile blocks in the service area, checked against GPS of buses in service.

    python pipeline/osrm/scan_blockers.py <israel.osm.pbf> <out dir> [--days 2026-11-10,2026-11-12,2026-11-15]
        [--write-exceptions]

Public data only (OpenStreetMap + Open Bus Stride SIRI GPS): nothing of an operator's own data is read or written.

1. Blockers (rules of pipeline/osrm/profiles/bus_common.lua, bus dimensions in bus_dimensions.lua): a routable way with a
   dimension tag below the bus (maxheight / maxweight / maxwidth / width / maxlength, :physical, :forward/:backward,
   narrow), and a node on a routable way that blocks the bus (barrier not passable, maxheight below the bus, access).
   Turn restrictions are NOT checked here. Rows already in local/bus_exceptions.csv are skipped.
2. Strict GPS match (all operators, DAYS, 06:00-20:00 Israel): a point counts when the nearest OSM highway segment is the
   blocker itself within NEAR_M, the nearest OTHER way is more than OTHER_M away, and (ways) the heading follows the way
   in a blocked direction. One pass = one ride (siri_ride__id). A way is probed on +-PROBE_M around its middle.
   Screen first: no bus point at all in the box on two weekday peaks (07-09) = "none" without the full check.
3. Verdict: "auto" = at least AUTO_RIDES rides over the days and at least AUTO_PER_DAY on each day (David's rule,
   17.11.2026: "מה שברור וודאי לאשר"); "border" = some rides; "none" = no ride. --write-exceptions appends the "auto" ones
   to local/bus_exceptions.csv (approved_by "David (auto-rule 17.11)").
   Guards (hand check of the first run): no "auto" for a clearance under AUTO_MIN_HEIGHT, or when GPS drift from another
   road is possible (a parallel road within DRIFT_M of a way, any road within NEAR_M of a node) unless rides >= DRIFT_RIDES;
   those are "border" with the reason in "caution".
Output: <out>/blockers_scan.json and <out>/blockers_scan.md (Hebrew)."""
import json, os, sys, math, re, time, csv, collections, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor
import osmium

HERE = os.path.dirname(os.path.abspath(__file__))
EXC_FILE = os.path.join(HERE, "local", "bus_exceptions.csv")
API = "https://open-bus-stride-api.hasadna.org.il"
REGION = (31.70, 32.20, 34.72, 35.30)  # Jerusalem area, Mevaseret, Givat Ze'ev, Beit Horon, 443, Route 1, Gush Dan
DAYS = ["2026-11-10", "2026-11-12", "2026-11-15"]
NEAR_M, OTHER_M, HEAD_DEG, PAD_DEG = 8, 5, 35, 0.00015
PROBE_M = 100   # a way is probed on +-100 m around its middle (the tag applies to the whole way; a small GPS box)
WORKERS = 4     # gentle on the Stride API
AUTO_RIDES, AUTO_PER_DAY = 20, 3
# Guards found by hand-checking the first run (17.11): "auto" only when it is clear and certain, otherwise "border" for David.
AUTO_MIN_HEIGHT = 3.3   # a clearance under 3.3 m: a standard bus does not fit; rides there are minibuses or GPS drift
DRIFT_M = 15            # a parallel road this close to a way (or any road within NEAR_M of a node) can leak GPS drift ...
DRIFT_RIDES = 10 * AUTO_RIDES  # ... unless the rides are overwhelming (drift does not make hundreds of rides)
NOT_VEHICLE = {"footway", "pedestrian", "path", "cycleway", "steps", "bridleway", "proposed", "construction", "corridor", "platform", "elevator"}
DIM = {"height_m": 4.0, "width_m": 2.55, "length_m": 12.5, "weight_t": 19.5}
SPEEDS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary",
          "tertiary_link", "unclassified", "residential", "living_street", "service", "busway"}
BLACK = {"no", "agricultural", "forestry", "emergency", "taxi", "share_taxi", "foot", "emergency_vehicle", "restricted", "military", "official"}
HIER = ["bus", "psv", "motor_vehicle", "vehicle", "access"]
BARRIER_OK = {"cattle_grid", "border_control", "toll_booth", "sally_port", "no", "entrance", "height_restrictor", "arch", "bus_trap",
              "sump_buster", "gate", "lift_gate"}
UA = {"User-Agent": "deadhead-bus-review/1.0"}


def num(raw, kind):
    s = (raw or "").strip().lower().replace(",", ".")
    m = re.match(r"^([\d.]+)\s*m?$", s) if kind == "m" else re.match(r"^([\d.]+)\s*t?$", s)
    try:
        if m: return float(m.group(1))
        if kind == "m":
            f = re.match(r"^(\d+)\s*'\s*(\d*)\s*\"?$", s)
            if f: return int(f.group(1)) * 0.3048 + int(f.group(2) or 0) * 0.0254
        else:
            k = re.match(r"^([\d.]+)\s*kg$", s)
            if k: return float(k.group(1)) / 1000
    except ValueError: pass
    return None


CHECKS = [(["maxheight:physical", "maxheight"], "m", "height_m", False), (["maxwidth:physical", "maxwidth"], "m", "width_m", False),
          (["width", "est_width"], "m", "width_m", True), (["maxlength"], "m", "length_m", False), (["maxweight", "maxweightrating"], "t", "weight_t", False)]


def dim_block(t, d):
    for keys, kind, lim, incl in CHECKS:
        for key in keys:
            tag = f"{key}:{d}"; raw = t.get(tag)
            if raw is None: tag = key; raw = t.get(key)
            if raw is not None:
                v = num(raw, kind)
                if v is not None and (v <= DIM[lim] if incl else v < DIM[lim]): return f"{tag}={raw}"
                break
    if t.get("narrow") and t["narrow"] != "no": return f"narrow={t['narrow']}"
    return None


def node_block(t):
    for k in HIER:
        if k in t:
            return f"{k}={t[k]}" + (f" barrier={t['barrier']}" if t.get("barrier") else "") if t[k] in BLACK else None
    b = t.get("barrier")
    if b and b not in BARRIER_OK and t.get("bollard") != "rising" and t.get("kerb") not in ("lowered", "flush") \
            and not (b == "kerb" and t.get("highway") == "crossing") and not (b == "fence" and t.get("sensory") in ("audible", "audio")):
        return f"barrier={b}"
    for key in ("maxheight:physical", "maxheight"):
        if key in t:
            h = num(t[key], "m")
            return f"{key}={t[key]}" if h is not None and h < DIM["height_m"] else None
    return None


def exceptions():
    out = set()
    if os.path.exists(EXC_FILE):
        for row in csv.reader(l for l in open(EXC_FILE, encoding="utf-8") if l.strip() and not l.lstrip().startswith("#")):
            if len(row) >= 2 and row[0] in ("way", "node"): out.add(f"{row[0]}:{row[1]}")
    return out


inside = lambda lat, lon: REGION[0] <= lat <= REGION[1] and REGION[2] <= lon <= REGION[3]


class Pass1(osmium.SimpleHandler):
    """blocking ways (with geometry) and the ids of nodes on routable ways"""
    def __init__(self, exc):
        super().__init__(); self.exc = exc; self.ways = []; self.nodes = {}; self.on_road = collections.defaultdict(list)
    def node(self, n):
        if len(n.tags) and inside(n.location.lat, n.location.lon):
            t = {x.k: x.v for x in n.tags}
            r = node_block(t)
            if r and f"node:{n.id}" not in self.exc: self.nodes[n.id] = dict(kind="node", id=n.id, tag=r, loc=(n.location.lat, n.location.lon), tags=t)
    def way(self, w):
        hw = w.tags.get("highway")
        if hw not in SPEEDS: return
        try: geo = [(n.location.lat, n.location.lon) for n in w.nodes]
        except osmium.InvalidLocationError: return
        if not any(inside(*p) for p in geo): return
        for n in w.nodes: self.on_road[n.ref].append(w.id)
        t = {x.k: x.v for x in w.tags}
        f, b = dim_block(t, "forward"), dim_block(t, "backward")
        oneway = t.get("oneway") in ("yes", "1", "true") or hw in ("motorway",) or t.get("junction") == "roundabout"
        if t.get("oneway") == "-1": oneway = True; f, b = b, f; geo = geo[::-1]
        if (f or (b and not oneway)) and f"way:{w.id}" not in self.exc:
            self.ways.append(dict(kind="way", id=w.id, tag=f or b, dirs=[d for d, x in (("fw", f), ("bw", None if oneway else b)) if x],
                                  geo=geo, name=t.get("name:he") or t.get("name", ""), highway=hw, ref=t.get("ref", "")))


class Pass2(osmium.SimpleHandler):
    """every highway segment near a blocker (for the "nearest way is the blocker" test)"""
    def __init__(self, boxes):
        super().__init__(); self.boxes = boxes; self.segs = collections.defaultdict(list); self.info = {}
        self.grid = collections.defaultdict(list)
        for i, b in enumerate(boxes):
            for gx in range(int(b[0] * 200), int(b[1] * 200) + 1):
                for gy in range(int(b[2] * 200), int(b[3] * 200) + 1): self.grid[(gx, gy)].append(i)
    def way(self, w):
        if "highway" not in w.tags: return
        try: geo = [(n.location.lat, n.location.lon) for n in w.nodes]
        except osmium.InvalidLocationError: return
        hit = set()
        for p in geo: hit.update(self.grid.get((int(p[0] * 200), int(p[1] * 200)), ()))
        if hit:
            t = w.tags
            self.info[w.id] = dict(highway=t.get("highway"), name=t.get("name:he") or t.get("name", ""), oneway=t.get("oneway") in ("yes", "1", "-1") or t.get("junction") == "roundabout",
                                   dims={k: v for k, v in t if k.split(":")[0] in ("maxheight", "maxweight", "maxweightrating", "maxwidth", "width", "maxlength")})
        for i in hit:
            b = self.boxes[i]
            for k in range(len(geo) - 1):
                a, c = geo[k], geo[k + 1]
                if max(a[0], c[0]) >= b[0] and min(a[0], c[0]) <= b[1] and max(a[1], c[1]) >= b[2] and min(a[1], c[1]) <= b[3]:
                    self.segs[i].append((w.id, a, c))


def xy(p, lat0): return (p[1] * 111320 * math.cos(math.radians(lat0)), p[0] * 110540)


def dseg(p, a, b, lat0):
    P, A, B = xy(p, lat0), xy(a, lat0), xy(b, lat0); dx, dy = B[0] - A[0], B[1] - A[1]; L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L))
    return math.hypot(P[0] - A[0] - t * dx, P[1] - A[1] - t * dy)


def bearing(a, b):
    y = math.sin(math.radians(b[1] - a[1])) * math.cos(math.radians(b[0]))
    x = math.cos(math.radians(a[0])) * math.sin(math.radians(b[0])) - math.sin(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.cos(math.radians(b[1] - a[1]))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def probe(geo):
    """the part of a way within PROBE_M of its middle (by length), cut at those distances"""
    if len(geo) < 2: return geo
    lat0 = geo[0][0]; L = [0.0]
    for a, b in zip(geo, geo[1:]): L.append(L[-1] + math.dist(xy(a, lat0), xy(b, lat0)))
    lo, hi = L[-1] / 2 - PROBE_M, L[-1] / 2 + PROBE_M
    if lo <= 0 and hi >= L[-1]: return geo
    def at(d):
        for i in range(len(geo) - 1):
            if L[i + 1] >= d:
                t = 0 if L[i + 1] == L[i] else (d - L[i]) / (L[i + 1] - L[i])
                return (geo[i][0] + t * (geo[i + 1][0] - geo[i][0]), geo[i][1] + t * (geo[i + 1][1] - geo[i][1]))
        return geo[-1]
    lo, hi = max(lo, 0), min(hi, L[-1])
    return [at(lo)] + [p for p, d in zip(geo, L) if lo < d < hi] + [at(hi)]


def get(url):
    for t in range(5):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120))
        except Exception as e: err = e; time.sleep(3 * (t + 1))
    raise err


def screened_out(box):
    """cheap first look (the API cost grows with the time window, not the box): any bus point at all in the box on two
    weekday peaks (07:00-09:00 Israel on the first and last day)? No point = no service, no full check."""
    for day in (DAYS[0], DAYS[-1]):
        p = dict(limit=1, lat__greater_or_equal=box[0], lat__lower_or_equal=box[1], lon__greater_or_equal=box[2], lon__lower_or_equal=box[3],
                 recorded_at_time_from=f"{day}T05:00:00Z", recorded_at_time_to=f"{day}T07:00:00Z")
        if get(f"{API}/siri_vehicle_locations/list?" + urllib.parse.urlencode(p)): return False
    return True


def gps(box, day):
    """all SIRI points in a small box on one day 06-20 Israel, in 2-hour windows (a long window is slow on the API)"""
    def q(h0, h1):
        out, off = [], 0
        while True:
            p = dict(limit=1000, offset=off, lat__greater_or_equal=box[0], lat__lower_or_equal=box[1], lon__greater_or_equal=box[2],
                     lon__lower_or_equal=box[3], recorded_at_time_from=f"{day}T{h0:02d}:00:00Z", recorded_at_time_to=f"{day}T{h1:02d}:00:00Z")
            part = get(f"{API}/siri_vehicle_locations/list?" + urllib.parse.urlencode(p)); out += part
            if len(part) < 1000 or off > 30000: return out
            off += 1000
    return [x for h in range(4, 18, 2) for x in q(h, h + 2)]


def check(b, segs):
    """strict match -> {rides, per_day, lines}"""
    lat0 = b["box"][0]
    own = [(a, c) for wid, a, c in segs if (b["kind"] == "way" and wid == b["id"])] if b["kind"] == "way" else []
    ways_at_node = set(b.get("ways") or [])
    rides = {}; per_day = collections.Counter(); lines = collections.Counter()
    for day in DAYS:
        for x in gps(b["box"], day):
            p = (x["lat"], x["lon"])
            dmin = collections.defaultdict(lambda: 1e9)
            for wid, a, c in segs: dmin[wid] = min(dmin[wid], dseg(p, a, c, lat0))
            if b["kind"] == "way":
                mine = dmin.get(b["id"], 1e9); other = min([d for w, d in dmin.items() if w != b["id"]] or [1e9])
                if mine > NEAR_M or other <= OTHER_M: continue
                k = min(range(len(own)), key=lambda i: dseg(p, *own[i], lat0)); sb = bearing(*own[k]); hb = x.get("bearing")
                if hb is None: continue
                diff = abs(((hb - sb) % 360 + 540) % 360 - 180)
                d = "fw" if diff <= HEAD_DEG else "bw" if diff >= 180 - HEAD_DEG else None
                if d not in b["dirs"]: continue
            else:
                if dseg(p, b["loc"], b["loc"], lat0) > NEAR_M: continue
                near = sorted(dmin.items(), key=lambda kv: kv[1])
                if not near or near[0][0] not in ways_at_node: continue
                if any(d <= OTHER_M for w, d in near if w not in ways_at_node): continue
            rid = x.get("siri_ride__id")
            if rid in rides: continue
            rides[rid] = day; per_day[day] += 1; lines[(x.get("siri_route__operator_ref"), x.get("siri_route__line_ref"))] += 1
    return dict(rides=len(rides), per_day={d: per_day[d] for d in DAYS}, lines=[[o, l, n] for (o, l), n in lines.most_common()])


def caution(b, segs, info):
    """why an otherwise "auto" blocker is not clear and certain (None = clear)"""
    key, _, val = b["tag"].partition("=")
    if key.split(":")[0] == "maxheight":
        h = num(val, "m")
        if h is not None and h < AUTO_MIN_HEIGHT: return f"גובה {val} מ' – אוטובוס רגיל לא עובר; כנראה מיניבוס או סטיית GPS"
    if b["rides"] >= DRIFT_RIDES: return None
    p = b.get("mid") or b["loc"]; lat0 = p[0]
    if b["kind"] == "node":
        for wid, a, c in segs:
            I = info.get(wid, {})
            if wid in (b.get("ways") or []) or I.get("highway") in NOT_VEHICLE: continue
            if dseg(p, a, c, lat0) <= NEAR_M: return f"דרך אחרת ({I.get('highway')}, way {wid}) במרחק עד {NEAR_M} מ' – ייתכן שהנקודות שלה"
        return None
    own = [(a, c) for wid, a, c in segs if wid == b["id"]]
    if not own: return None
    sb = bearing(*min(own, key=lambda s: dseg(p, *s, lat0)))
    mine = {kk: vv for kk, vv in info.get(b["id"], {}).get("dims", {}).items()}
    for wid, a, c in segs:
        I = info.get(wid, {})
        if wid == b["id"] or I.get("highway") in NOT_VEHICLE or (mine and I.get("dims") == mine): continue
        if dseg(p, a, c, lat0) > DRIFT_M: continue
        diff = abs(((bearing(a, c) - sb) % 360 + 540) % 360 - 180)
        if diff <= HEAD_DEG or (diff >= 180 - HEAD_DEG and not I.get("oneway")):
            return f"כביש מקביל ({I.get('highway')}, way {wid}) עד {DRIFT_M} מ' – ייתכן שחלק מהנקודות שלו"
    return None


def main():
    pbf, out = sys.argv[1], sys.argv[2]
    global DAYS
    if "--days" in sys.argv: DAYS = sys.argv[sys.argv.index("--days") + 1].split(",")
    os.makedirs(out, exist_ok=True)
    only = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None  # hand checks: "way:1,node:2"
    exc = exceptions() if not only else set()
    h1 = Pass1(exc); h1.apply_file(pbf, locations=True, idx="flex_mem")
    nodes = [dict(n, ways=h1.on_road[n["id"]]) for n in h1.nodes.values() if h1.on_road.get(n["id"])]
    B = h1.ways + nodes
    if only: B = [b for b in B if f"{b['kind']}:{b['id']}" in only]
    for b in B:
        if b["kind"] == "way": b["geo"] = probe(b["geo"]); b["mid"] = b["geo"][len(b["geo"]) // 2]
        pts = b.get("geo") or [b["loc"]]
        b["box"] = (min(p[0] for p in pts) - PAD_DEG, max(p[0] for p in pts) + PAD_DEG, min(p[1] for p in pts) - PAD_DEG, max(p[1] for p in pts) + PAD_DEG)
    print(f"blockers in the region: {len(h1.ways)} ways, {len(nodes)} nodes (exceptions skipped: {len(exc)})", flush=True)
    h2 = Pass2([b["box"] for b in B]); h2.apply_file(pbf, locations=True, idx="flex_mem")
    done = {}
    cache = os.path.join(out, "blockers_scan.json" if not only else "blockers_only.json")
    if os.path.exists(cache):
        for r in json.load(open(cache, encoding="utf-8"))["blockers"]:
            if r.get("days") == DAYS and "rides" in r: done[f"{r['kind']}:{r['id']}"] = r

    def one(i):
        b = B[i]; key = f"{b['kind']}:{b['id']}"
        if key in done: return {**{k: v for k, v in b.items() if k not in ("geo", "tags")}, **{k: done[key][k] for k in ("rides", "per_day", "lines") }, "screened": done[key].get("screened"), "days": DAYS}
        r = None
        for attempt in range(3):
            try:
                r = dict(rides=0, per_day={d: 0 for d in DAYS}, lines=[], screened=True) if screened_out(b["box"]) else check(b, h2.segs.get(i, []))
                break
            except Exception as e: r = dict(err=str(e)); time.sleep(20 * (attempt + 1))
        return {**{k: v for k, v in b.items() if k not in ("geo", "tags")}, **r, "days": DAYS}
    res = []
    with ThreadPoolExecutor(WORKERS) as ex:
        for k, r in enumerate(ex.map(one, range(len(B)))):
            res.append(r)
            if k % 25 == 0: print("checked", k, "of", len(B), flush=True)
            if k % 10 == 0: json.dump(dict(days=DAYS, blockers=res), open(cache, "w", encoding="utf-8"), ensure_ascii=False)
    for i, r in enumerate(res):  # res[i] is B[i] (ex.map keeps the order)
        if r["kind"] == "node" and not r.get("name"):  # a node has no name: the street it is on
            r["name"] = next((h2.info[w]["name"] for w in r.get("ways") or [] if h2.info.get(w, {}).get("name")), "")
        if "rides" not in r: r["verdict"] = "error"
        elif r["rides"] >= AUTO_RIDES and all(r["per_day"].get(d, 0) >= AUTO_PER_DAY for d in DAYS):
            r["caution"] = caution(r, h2.segs.get(i, []), h2.info)
            r["verdict"] = "border" if r["caution"] else "auto"
        elif r["rides"] > 0: r["verdict"] = "border"
        else: r["verdict"] = "none"
    json.dump(dict(days=DAYS, region=REGION, rule=dict(near_m=NEAR_M, other_m=OTHER_M, auto_rides=AUTO_RIDES, auto_per_day=AUTO_PER_DAY),
                   blockers=res), open(cache, "w", encoding="utf-8"), ensure_ascii=False)
    if only:
        for r in res: print(r["kind"], r["id"], r.get("name"), r["tag"], r.get("dirs"), "rides", r.get("rides"), r.get("per_day"), r.get("lines", [])[:6], r.get("err"))
        return
    c = collections.Counter(r["verdict"] for r in res)
    md = ["# חסמים בפרופיל האוטובוס מול GPS של שירות קיים", "",
          f"אזור: ירושלים והסביבה, מבשרת, גבעת זאב/בית חורון, 443, כביש 1, גוש דן. ימים: {', '.join(DAYS)}, 06:00–20:00, כל המפעילים.",
          "סינון ראשוני: מקטע בלי אף נקודת GPS של אוטובוס בשעות השיא (07:00–09:00) בשני ימים נחשב \"אין שירות\" בלי בדיקה מלאה.",
          f"נסרקו {len(res)} חסמים: אישור אוטומטי {c['auto']}, גבולי (לדוד) {c['border']}, בלי שירות {c['none']}, תקלה בבדיקה {c['error']}.",
          "איסורי פנייה לא נבדקו.", "", "| הכרעה | סוג | מזהה | רחוב | חסם | נסיעות | לפי יום | הערה |", "|---|---|---|---|---|---|---|---|"]
    V = {"auto": "אושר אוטומטית", "border": "גבולי – לדוד", "none": "אין שירות", "error": "תקלה"}
    for r in sorted(res, key=lambda r: ({"auto": 0, "border": 1, "error": 2, "none": 3}[r["verdict"]], -r.get("rides", 0))):
        if r["verdict"] == "none": continue
        md.append(f"| {V[r['verdict']]} | {r['kind']} | [{r['id']}](https://www.openstreetmap.org/{r['kind']}/{r['id']}) | {r.get('name', '')} | {r['tag']} | {r.get('rides', '')} | "
                  f"{' / '.join(str(r.get('per_day', {}).get(d, 0)) for d in DAYS)} | {r.get('caution') or ''} |")
    open(os.path.join(out, "blockers_scan.md"), "w", encoding="utf-8").write("\n".join(md) + "\n")
    print(dict(c))
    if "--write-exceptions" in sys.argv:
        rows = []
        for r in res:
            if r["verdict"] != "auto": continue
            tag = r["tag"].split("=")[0].split(":")[0]
            ignore = {"maxweightrating": "maxweight", "est_width": "width"}.get(tag, tag)
            if r["kind"] == "node": ignore = "maxheight" if tag == "maxheight" else "barrier"
            reason = (f"{r.get('name') or r.get('highway', '')} ({r['tag']}): שירות קיים - {r['rides']} נסיעות שונות "
                      f"({' / '.join(str(r['per_day'][d]) for d in DAYS)} ב־{', '.join(d[8:] + '.' + d[5:7] for d in DAYS)}), התאמה מחמירה עד {NEAR_M} מ'").replace('"', "'")
            rows.append(f'{r["kind"]},{r["id"]},{ignore},"{reason}",David (auto-rule 17.11),{time.strftime("%Y-%m-%d")}')
        if rows:
            with open(EXC_FILE, "a", encoding="utf-8") as fh: fh.write("\n".join(rows) + "\n")
        print("exceptions written:", len(rows))


if __name__ == "__main__":
    main()
