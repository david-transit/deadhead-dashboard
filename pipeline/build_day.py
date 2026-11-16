"""Build one day for one operator:  python pipeline/build_day.py YYYY-MM-DD [--op derech-egged]

Fetches the operator's rides (Open Bus Stride), finds route ends, computes trips and empty legs
(OSRM road km), writes plaintext data/<slug>/day_<day>.json (gitignored), encrypts it to data/<slug>/day_<day>.js
and rewrites data/<slug>/days.js from the encrypted files present. Operators: pipeline/operators.json.

Caches (never committed, shared by all operators): pipeline/cache/ or $DEADHEAD_CACHE.
Data key (per operator): $DATA_KEY_FILE or config/.data_key_<slug> (base64, 32 bytes).
Night legs (depot <-> first/last stop) are computed in the browser from the Supabase settings."""
import json, sys, os, glob, hashlib, subprocess, datetime as dt, urllib.request, time, zipfile, csv, io, collections, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from stride import TZ, operator, fetch_rides, update_route_ends

REPO = os.path.dirname(HERE)
CACHE_DIR = os.environ.get("DEADHEAD_CACHE") or os.path.join(HERE, "cache")
OP = DATA = KEY_FILE = DAY_START_H = None  # set per operator in main()


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


def load_prev(day):
    """Where each vehicle ended the previous service day (for the inferred overnight leg).
    Reads data/<slug>/day_<D-1>.json, or decrypts data/<slug>/day_<D-1>.js with the data key."""
    pd = (dt.date.fromisoformat(day) - dt.timedelta(days=1)).isoformat()
    jf, ef = os.path.join(DATA, f"day_{pd}.json"), os.path.join(DATA, f"day_{pd}.js")
    try:
        if os.path.exists(jf):
            P = json.load(open(jf, encoding="utf-8"))
        elif os.path.exists(ef) and os.path.exists(KEY_FILE):
            P = json.loads(subprocess.run(["node", os.path.join(HERE, "decrypt.js"), KEY_FILE, ef],
                                          check=True, capture_output=True).stdout.decode("utf-8"))
        else:
            print("no previous day", pd, file=sys.stderr); return {}
    except Exception as e:
        print("previous day unreadable", pd, e, file=sys.stderr); return {}
    out = {}
    for v in P.get("vehicles", []):
        t = [i for i in v["items"] if i["kind"] == "trip"]
        if not t or not v.get("last_d"): continue
        # minutes relative to day D's midnight (negative = the evening before)
        out[v["veh"]] = dict(end=t[-1]["end"] - 1440, line=t[-1]["line"], to=t[-1]["to"],
                             lat=v["last_d"][0], lon=v["last_d"][1], city=v["last_d"][2])
    print("previous day", pd, "vehicles:", len(out), file=sys.stderr)
    return out


def build(day):
    os.makedirs(CACHE_DIR, exist_ok=True)
    rf = os.path.join(CACHE_DIR, f"rides_{OP['slug']}_{day}_h{DAY_START_H}.json")
    raw = json.load(open(rf, encoding="utf-8")) if os.path.exists(rf) else fetch_rides(day, rf, OP["operator_ref"], DAY_START_H)
    ends = update_route_ends(raw, os.path.join(CACHE_DIR, "route_ends.json"))
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
            t = dict(line=x["gtfs_route__route_short_name"], mkt=x["gtfs_route__route_mkt"], o=e["o"], d=e["d"], km=round(e["km"], 1))
        else:
            # ran in service but not in the licensed GTFS schedule -> automatic reinforcement candidate
            info = LR.get(str(x["siri_route__line_ref"]))
            e = ends.get(str(info["route"])) if info else None
            dur = x["duration_minutes"] or 30
            t = dict(line=info["line"] if info else "?", mkt=info["mkt"] if info else None,
                     o=e["o"] if e else None, d=e["d"] if e else None, km=round(e["km"], 1) if e else None,
                     auto=True, line_ref=x["siri_route__line_ref"], **({} if e else {"unmapped": True}),
                     **({} if x["duration_minutes"] else {"dur_est": True}))
            auto_n += 1; auto_unmapped += 0 if e else 1
        seen.add(k)
        t.update(start=round(mins(st)), end=round(mins(st) + dur), cls=CL.get(t["mkt"], "לא ידוע"))
        by[x["vehicle_ref"]].append(t)
    place = lambda q: f"{q[2]}, {q[3]}" if q else "לא ידוע"

    prev = load_prev(day)
    vehicles = []; tot_day = 0
    for v, ts in sorted(by.items()):
        ts.sort(key=lambda t: t["start"])
        cls = collections.Counter(t["cls"] for t in ts if not t.get("auto")).most_common(1)
        cls = cls[0][0] if cls else ts[0]["cls"]
        items = []
        for i, t in enumerate(ts):
            if i:
                p = ts[i - 1]; km, mn = road(p["d"], t["o"]) if p["d"] and t["o"] else (None, None)
                items.append(dict(kind="empty", start=p["end"], end=t["start"], km=km, drive_min=mn, overlap=t["start"] < p["end"],
                                  frm=place(p["d"]), to=place(t["o"])))
                if km: tot_day += km
            items.append(dict(kind="trip", start=t["start"], end=t["end"], line=t["line"], km=t["km"], cls=t["cls"],
                              frm=place(t["o"]), to=place(t["d"]),
                              **{k: t[k] for k in ("auto", "line_ref", "unmapped", "dur_est") if k in t}))
        fo = next((t["o"] for t in ts if t["o"]), None); ld = next((t["d"] for t in reversed(ts) if t["d"]), None)
        if not fo or not ld: continue
        vehicles.append(dict(veh=v, cls=cls,
            first_o=[round(fo[0], 5), round(fo[1], 5), fo[3]],
            last_d=[round(ld[0], 5), round(ld[1], 5), ld[3]],
            service_km=round(sum(t["km"] for t in ts if not t.get("auto")), 1), items=items,
            empty_day_km=round(sum(i["km"] or 0 for i in items if i["kind"] == "empty"), 1),
            **({"prev": prev[v]} if v in prev else {})))

    # catalog of service routes (line + direction) seen this day, for marking reinforcement trips
    cat = {}
    for v, ts in by.items():
        for t in ts:
            if t.get("auto"): continue
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

    out = dict(day=day, day_start_min=DAY_START_H * 60, operator=OP["name"], operator_slug=OP["slug"], built=dt.datetime.now(TZ).isoformat(timespec="minutes"),
               routes=routes, summary=dict(vehicles=len(vehicles), trips=sum(len(v) for v in by.values()),
               empty_day_km=round(tot_day), skipped_rides=skipped, auto_rein=auto_n, auto_rein_unmapped=auto_unmapped), vehicles=vehicles)
    os.makedirs(DATA, exist_ok=True)
    json.dump(out, open(os.path.join(DATA, f"day_{day}.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(json.dumps(out["summary"], ensure_ascii=False))


def encrypt(day):
    subprocess.run(["node", os.path.join(HERE, "encrypt.js"), KEY_FILE, DATA, day], check=True)
    write_days_index()


def write_days_index():
    """data/<slug>/days.js: the list of built days + a short content hash per day (cache-busting ?v= for day_<D>.js)."""
    files = sorted(glob.glob(os.path.join(DATA, "day_*.js")))
    days = [os.path.basename(f)[4:14] for f in files]
    ver = {os.path.basename(f)[4:14]: hashlib.sha256(open(f, "rb").read()).hexdigest()[:10] for f in files}
    meta = dict(days=days, day_start_hour=DAY_START_H, name=OP["name"], ver=ver)
    open(os.path.join(DATA, "days.js"), "w", encoding="utf-8").write(
        f"(window.OPDAYS=window.OPDAYS||{{}})[{json.dumps(OP['slug'])}]=" + json.dumps(meta, ensure_ascii=False) + ";\n")
    print("days:", days)


def main():
    global OP, DATA, KEY_FILE, DAY_START_H
    args = sys.argv[1:]
    slug = "derech-egged"
    if "--op" in args:
        i = args.index("--op"); slug = args[i + 1]; del args[i:i + 2]
    day = args[0]
    dt.date.fromisoformat(day)
    OP = operator(slug)
    DAY_START_H = OP["service_day_start_hour"]
    DATA = os.path.join(REPO, "data", slug)
    KEY_FILE = os.environ.get("DATA_KEY_FILE") or os.path.join(REPO, "config", f".data_key_{slug}")
    if not os.path.exists(KEY_FILE):
        raise SystemExit("missing data key: " + KEY_FILE)
    build(day)
    encrypt(day)


if __name__ == "__main__":
    main()
