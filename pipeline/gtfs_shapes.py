"""Licensed route shapes of one operator from the MOT public GTFS (gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip),
as a small cache: python pipeline/gtfs_shapes.py <gtfs.zip> [--op derech-egged] [--out pipeline/cache/gtfs_shapes_<slug>.json]

Keeps only the operator's routes (agency_id = operator_ref): route_id (= Stride gtfs_route__line_ref) -> shape ids by number
of trips, trip number (trip_id before "_", = Stride gtfs_ride__journey_ref before "_") -> shape id, and each shape as
[[lat, lon], ...]. The zip is read as data only (never extracted), from a folder outside the repository.
Source and terms: see README "Data sources" (MOT GTFS, copyright the State of Israel)."""
import csv, io, json, os, sys, zipfile, collections, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", newline=""))


def extract(zip_path, agency_id):
    z = zipfile.ZipFile(zip_path)
    routes = {r["route_id"] for r in rows(z, "routes.txt") if r["agency_id"] == str(agency_id)}
    by_route = collections.defaultdict(collections.Counter); trips = {}
    for t in rows(z, "trips.txt"):
        if t["route_id"] in routes and t["shape_id"]:
            by_route[t["route_id"]][t["shape_id"]] += 1
            trips[t["trip_id"].split("_")[0]] = t["shape_id"]
    want = {s for c in by_route.values() for s in c}
    pts = collections.defaultdict(list)
    for p in rows(z, "shapes.txt"):
        if p["shape_id"] in want:
            pts[p["shape_id"]].append((int(p["shape_pt_sequence"]), round(float(p["shape_pt_lat"]), 6), round(float(p["shape_pt_lon"]), 6)))
    shapes = {s: [[a, b] for _, a, b in sorted(v)] for s, v in pts.items()}
    info = z.getinfo("shapes.txt").date_time
    return dict(src="https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip", agency_id=agency_id,
                gtfs_date=dt.datetime(*info).strftime("%Y-%m-%d"), made=dt.date.today().isoformat(),
                routes={r: [s for s, _ in c.most_common()] for r, c in by_route.items()}, trips=trips, shapes=shapes)


if __name__ == "__main__":
    a = sys.argv[1:]
    slug = a[a.index("--op") + 1] if "--op" in a else "derech-egged"
    op = next(o for o in json.load(open(os.path.join(HERE, "operators.json"), encoding="utf-8"))["operators"] if o["slug"] == slug)
    out = a[a.index("--out") + 1] if "--out" in a else os.path.join(os.environ.get("DEADHEAD_CACHE") or os.path.join(HERE, "cache"), f"gtfs_shapes_{slug}.json")
    r = extract(a[0], op["operator_ref"])
    json.dump(r, open(out, "w", encoding="utf-8"), separators=(",", ":"))
    print(f"{slug}: {len(r['routes'])} routes, {len(r['shapes'])} shapes, {sum(map(len, r['shapes'].values()))} points, "
          f"{len(r['trips'])} trips, gtfs {r['gtfs_date']} -> {out} ({os.path.getsize(out) // 1024} KB)")
