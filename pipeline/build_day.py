"""Build one day for the dashboard:  python pipeline/build_day.py YYYY-MM-DD [--force]

Fetches Derech Egged rides (Open Bus Stride), finds route ends, computes trips and empty legs
(OSRM road km), writes plaintext data/day_<day>.json (gitignored), encrypts it to data/day_<day>.js
and rewrites data/days.js from the encrypted files present.

Caches (never committed): pipeline/cache/ or $DEADHEAD_CACHE.
Data key: config/.data_key or $DATA_KEY_FILE (base64, 32 bytes).
Night legs (depot <-> first/last stop) are computed in the browser from the Supabase settings."""
import json, sys, os, glob, subprocess, datetime as dt, urllib.request, time, zipfile, csv, io, collections, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from stride import TZ, fetch_rides, update_route_ends

REPO = os.path.dirname(HERE)
DATA = os.path.join(REPO, "data")
CACHE_DIR = os.environ.get("DEADHEAD_CACHE") or os.path.join(HERE, "cache")
KEY_FILE = os.environ.get("DATA_KEY_FILE") or os.path.join(REPO, "config", ".data_key")


def osrm_router(cache_file):
    cache = json.load(open(cache_file, encoding="utf-8")) if os.path.exists(cache_file) else {}
    miss = [0]

    def road(p, q):
        if abs(p[0] - q[0]) < 1e-6 and abs(p[1] - q[1]) < 1e-6:
            return 0.0, 0.0
        k = f"{p[0]:.6f},{p[1]:.6f};{q[0]:.6f},{q[1]:.6f}"
        if k not in cache:
            u = f"https://router.project-osrm.org/route/v1/driving/{p[1]},{p[0]};{q[1]},{q[0]}?overview=false"
            for i in range(4):
                try:
                    with urllib.request.urlopen(u, timeout=60) as r:
                        x = json.load(r)["routes"][0]
                    cache[k] = [round(x["distance"] / 1000, 2), round(x["duration"] / 60, 1)]
                    break
                except Exception:
                    time.sleep(3 * (i + 1))
            else:
                miss[0] += 1
                return None, None
            time.sleep(0.15)
        return cache[k]

    def save():
        json.dump(cache, open(cache_file, "w", encoding="utf-8"))

    return road, save, miss


def build(day):
    os.makedirs(CACHE_DIR, exist_ok=True)
    rf = os.path.join(CACHE_DIR, f"rides_{day}.json")
    raw = json.load(open(rf, encoding="utf-8")) if os.path.exists(rf) else fetch_rides(day, rf)
    ends = update_route_ends(raw, os.path.join(CACHE_DIR, "route_ends.json"))
    z = zipfile.ZipFile(os.path.join(HERE, "ClusterToLine.zip")).read("ClusterToLine.txt").decode("utf-8-sig")
    CL = {x["OfficeLineId"]: ("עירוני" if x["LineTypeDesc"] == "עירוני" else "בינעירוני")
          for x in csv.DictReader(io.StringIO(z)) if "דרך אגד" in x["OperatorName"]}
    road, save_osrm, osrm_miss = osrm_router(os.path.join(CACHE_DIR, "osrm_cache.json"))

    midnight = dt.datetime.fromisoformat(day)  # local wall clock
    P = lambda s: dt.datetime.fromisoformat(s).astimezone(TZ).replace(tzinfo=None)
    mins = lambda t: (t - midnight).total_seconds() / 60

    by = collections.defaultdict(list); seen = set(); skipped = 0
    for x in raw:
        e = ends.get(str(x["gtfs_ride__gtfs_route_id"]))
        if not x["vehicle_ref"] or not e or not x["gtfs_ride__start_time"]:
            skipped += 1; continue
        k = (x["vehicle_ref"], x["scheduled_start_time"])
        if k in seen: continue
        seen.add(k)
        st = P(x["scheduled_start_time"])
        dur = (dt.datetime.fromisoformat(x["gtfs_ride__end_time"]) - dt.datetime.fromisoformat(x["gtfs_ride__start_time"])).total_seconds() / 60
        by[x["vehicle_ref"]].append(dict(line=x["gtfs_route__route_short_name"], mkt=x["gtfs_route__route_mkt"],
            start=round(mins(st)), end=round(mins(st) + dur), o=e["o"], d=e["d"], km=round(e["km"], 1),
            cls=CL.get(x["gtfs_route__route_mkt"], "לא ידוע")))

    vehicles = []; tot_day = 0
    for v, ts in sorted(by.items()):
        ts.sort(key=lambda t: t["start"])
        cls = collections.Counter(t["cls"] for t in ts).most_common(1)[0][0]
        items = []
        for i, t in enumerate(ts):
            if i:
                p = ts[i - 1]; km, mn = road(p["d"], t["o"])
                items.append(dict(kind="empty", start=p["end"], end=t["start"], km=km, drive_min=mn, overlap=t["start"] < p["end"],
                                  frm=f'{p["d"][2]}, {p["d"][3]}', to=f'{t["o"][2]}, {t["o"][3]}'))
                if km: tot_day += km
            items.append(dict(kind="trip", start=t["start"], end=t["end"], line=t["line"], km=t["km"], cls=t["cls"],
                              frm=f'{t["o"][2]}, {t["o"][3]}', to=f'{t["d"][2]}, {t["d"][3]}'))
        vehicles.append(dict(veh=v, cls=cls,
            first_o=[round(ts[0]["o"][0], 5), round(ts[0]["o"][1], 5), ts[0]["o"][3]],
            last_d=[round(ts[-1]["d"][0], 5), round(ts[-1]["d"][1], 5), ts[-1]["d"][3]],
            service_km=round(sum(t["km"] for t in ts), 1), items=items,
            empty_day_km=round(sum(i["km"] or 0 for i in items if i["kind"] == "empty"), 1)))

    # catalog of service routes (line + direction) seen this day, for marking reinforcement trips
    cat = {}
    for v, ts in by.items():
        for t in ts:
            k = (t["line"], t["o"][2], t["d"][2])
            c = cat.setdefault(k, dict(line=t["line"], frm=f'{t["o"][2]}, {t["o"][3]}', to=f'{t["d"][2]}, {t["d"][3]}',
                o=[round(t["o"][0], 5), round(t["o"][1], 5)], d=[round(t["d"][0], 5), round(t["d"][1], 5)],
                km=t["km"], cls=t["cls"], durs=[]))
            c["durs"].append(t["end"] - t["start"])
    routes = []
    for c in cat.values():
        c["dur"] = round(statistics.median(c.pop("durs"))); routes.append(c)
    routes.sort(key=lambda c: (c["line"].zfill(5), c["frm"]))
    save_osrm()

    n_empty = sum(1 for v in vehicles for i in v["items"] if i["kind"] == "empty")
    if not vehicles:
        raise SystemExit(f"{day}: no vehicles built")
    if n_empty and osrm_miss[0] > 0.2 * n_empty:
        raise SystemExit(f"{day}: OSRM failed for {osrm_miss[0]}/{n_empty} empty legs")

    out = dict(day=day, operator="דרך אגד עוטף ירושלים", built=dt.datetime.now(TZ).isoformat(timespec="minutes"),
               routes=routes, summary=dict(vehicles=len(vehicles), trips=sum(len(v) for v in by.values()),
               empty_day_km=round(tot_day), skipped_rides=skipped), vehicles=vehicles)
    os.makedirs(DATA, exist_ok=True)
    json.dump(out, open(os.path.join(DATA, f"day_{day}.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(json.dumps(out["summary"], ensure_ascii=False))


def encrypt(day):
    subprocess.run(["node", os.path.join(HERE, "encrypt.js"), KEY_FILE, DATA, day], check=True)
    days = sorted(os.path.basename(f)[4:14] for f in glob.glob(os.path.join(DATA, "day_*.js")))
    open(os.path.join(DATA, "days.js"), "w", encoding="utf-8").write("window.DAYS=" + json.dumps(days) + ";\n")
    print("days:", days)


if __name__ == "__main__":
    day = sys.argv[1]
    dt.date.fromisoformat(day)
    if not os.path.exists(KEY_FILE):
        raise SystemExit("missing data key: " + KEY_FILE)
    build(day)
    encrypt(day)
