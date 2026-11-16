"""Open Bus Stride API helpers: fetch one service day of an operator's rides, and route start/end stops."""
import json, sys, os, time, urllib.request, urllib.parse, datetime as dt
from zoneinfo import ZoneInfo

API = "https://open-bus-stride-api.hasadna.org.il"
CONFIG = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"), encoding="utf-8"))
TZ = ZoneInfo(CONFIG["timezone"])
UTC = dt.timezone.utc
OPERATORS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "operators.json"), encoding="utf-8"))["operators"]


def operator(slug):
    """Operator config from operators.json; service-day boundary can be overridden by env for experiments."""
    op = next((o for o in OPERATORS if o["slug"] == slug), None)
    if not op:
        raise SystemExit(f"unknown operator: {slug}")
    op = dict(op)
    op["service_day_start_hour"] = int(os.environ.get("SERVICE_DAY_START_HOUR", op["service_day_start_hour"]))
    return op


def get(path, params, tries=5):
    url = f"{API}{path}?" + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                return json.load(r)
        except Exception as e:
            print("retry", i + 1, e, file=sys.stderr)
            time.sleep(10 * (i + 1))
    raise SystemExit("API failed: " + url)


def day_bounds_utc(day, start_h):
    """Service day D: D at start_h local .. D+1 at start_h local, in UTC."""
    d = dt.date.fromisoformat(day)
    a = dt.datetime.combine(d, dt.time(start_h), TZ).astimezone(UTC)
    b = dt.datetime.combine(d + dt.timedelta(days=1), dt.time(start_h), TZ).astimezone(UTC)
    return a, b


def fetch_rides(day, out_file, operator_ref, start_h):
    a, end = day_bounds_utc(day, start_h)
    fmt = lambda t: t.strftime("%Y-%m-%dT%H:%M:%S+00:00")
    out = []
    while a < end:
        b = min(a + dt.timedelta(minutes=30), end)
        rows = get("/siri_rides/list", {"limit": 5000, "siri_route__operator_refs": operator_ref,
                                        "scheduled_start_time_from": fmt(a), "scheduled_start_time_to": fmt(b)})
        if len(rows) >= 5000:
            raise SystemExit(f"chunk {fmt(a)} hit the 5000 limit")
        rows = [r for r in rows if r["scheduled_start_time"] < fmt(b)]
        print(fmt(a), len(rows), file=sys.stderr)
        out += rows
        a = b
    if not out:
        raise SystemExit(f"no rides returned for {day}")
    tmp = out_file + ".tmp"
    json.dump(out, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    os.replace(tmp, out_file)
    return out


def update_route_ends(rides, cache_file):
    ends = json.load(open(cache_file, encoding="utf-8")) if os.path.exists(cache_file) else {}
    need = {}
    for x in rides:
        k = str(x["gtfs_ride__gtfs_route_id"])
        if x["gtfs_ride_id"] and k not in ends:
            need.setdefault(k, x["gtfs_ride_id"])
    ids = list(need.values())
    print("route ends needed:", len(ids), file=sys.stderr)
    if not ids:
        return ends
    days = sorted(x["scheduled_start_time"][:10] for x in rides)
    w0 = (dt.date.fromisoformat(days[0]) - dt.timedelta(days=1)).isoformat() + "T00:00:00+00:00"
    w1 = (dt.date.fromisoformat(days[-1]) + dt.timedelta(days=2)).isoformat() + "T00:00:00+00:00"
    for i in range(0, len(ids), 15):
        rows = get("/gtfs_ride_stops/list", {"limit": 5000, "gtfs_ride_ids": ",".join(map(str, ids[i:i + 15])),
                                             "arrival_time_from": w0, "arrival_time_to": w1})
        by = {}
        for s in rows:
            by.setdefault(s["gtfs_ride__gtfs_route_id"], []).append(s)
        for rid, ss in by.items():
            ss.sort(key=lambda s: s["stop_sequence"])
            a, b = ss[0], ss[-1]
            ends[str(rid)] = {"o": [a["gtfs_stop__lat"], a["gtfs_stop__lon"], a["gtfs_stop__name"], a["gtfs_stop__city"]],
                              "d": [b["gtfs_stop__lat"], b["gtfs_stop__lon"], b["gtfs_stop__name"], b["gtfs_stop__city"]],
                              "km": (b["shape_dist_traveled"] or 0) / 1000}
        print("route ends:", i + 15, "/", len(ids), file=sys.stderr)
        json.dump(ends, open(cache_file, "w", encoding="utf-8"), ensure_ascii=False)
    return ends
