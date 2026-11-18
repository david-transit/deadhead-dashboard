"""Where an empty trip starts and ends (R53, David 18.11):
  next to a service trip -> that trip's first / last stop in the GTFS of the same day (R48), not the operator's place name
  (the operator's names are inconsistent: one stop under two names, one name for two stops by direction);
  start / end of the sequence -> the depot named in the operator's description (settings "depots", plus aliases);
  anything else -> end_src "unresolved", listed for David.
The sequence passed in is a vehicle's executed trips of the day (dispatcher empties join sidurim of one vehicle), or a
sidur's planned trips for trips that were not done. Trips that were not done are never neighbours of executed ones."""
import collections, csv, io, math, zipfile


def gtfs_key(mkt8):
    m = int(mkt8) // 100
    return f'{m // 10}-{m % 10}'


def route_ends(gtfs_zip, mkt8s):
    want = {gtfs_key(m) for m in mkt8s}
    z = zipfile.ZipFile(gtfs_zip)
    rd = lambda n: csv.DictReader(io.TextIOWrapper(z.open(n), encoding='utf-8-sig'))
    rt = {}
    for r in rd('routes.txt'):
        k = '-'.join(r['route_desc'].split('-')[:2])
        if k in want:
            rt[r['route_id']] = k
    trips = {r['trip_id']: rt[r['route_id']] for r in rd('trips.txt') if r['route_id'] in rt}
    fl = {}
    for r in rd('stop_times.txt'):
        t = r['trip_id']
        if t in trips:
            s = int(r['stop_sequence']); a = fl.setdefault(t, [10 ** 9, None, -1, None])
            if s < a[0]: a[0], a[1] = s, r['stop_id']
            if s > a[2]: a[2], a[3] = s, r['stop_id']
    cnt = collections.defaultdict(lambda: (collections.Counter(), collections.Counter()))
    for t, a in fl.items():
        cnt[trips[t]][0][a[1]] += 1; cnt[trips[t]][1][a[3]] += 1
    need = {s for c in cnt.values() for x in c for s in x}
    st = {r['stop_id']: dict(code=r['stop_code'], name=r['stop_name'], lat=float(r['stop_lat']), lon=float(r['stop_lon']))
          for r in rd('stops.txt') if r['stop_id'] in need}
    return {k: (st[c[0].most_common(1)[0][0]], st[c[1].most_common(1)[0][0]]) for k, c in cnt.items()}


def annotate_service(trips, rends):
    """Set first / last stop on service trips from route_ends() output."""
    for t in trips:
        if t['kind'] == 'service':
            mk = (t.get('exec') or t.get('plan'))['mkt8']
            fl = rends.get(gtfs_key(mk))
            t['first'], t['last'] = fl if fl else (None, None)


def _depot(desc, depots, aliases, start):
    names = [(d['name'], d) for d in depots] + [(n, next((d for d in depots if d['id'] == i), None)) for n, i in aliases.items()]
    for n, d in sorted(names, key=lambda x: -len(x[0])):
        if d and (desc.startswith(n) if start else desc.endswith(n)):
            return dict(depot=d['id'], name=d['name'], lat=float(d['lat']), lon=float(d['lon']))
    return None


def resolve(trips, depots, aliases=None):
    aliases = aliases or {}
    for i, t in enumerate(trips):
        if t['kind'] != 'empty':
            continue
        done = t['status'] != 'not_done'
        peers = lambda seq: [x for x in seq if (x['status'] != 'not_done') == done]
        prv = next((x for x in reversed(peers(trips[:i]))), None)
        nxt = next((x for x in peers(trips[i + 1:])), None)
        desc = ((t.get('plan') or {}).get('desc') or t.get('desc') or '').strip()
        a = prv.get('last') if prv and prv['kind'] == 'service' else (None if prv else _depot(desc, depots, aliases, True))
        b = nxt.get('first') if nxt and nxt['kind'] == 'service' else (None if nxt else _depot(desc, depots, aliases, False))
        t['a'], t['b'] = a, b
        if a is None or b is None:
            t['end_src'] = 'unresolved'
        else:
            t['end_src'] = 'depot' if ('depot' in a or 'depot' in b) else 'gtfs'


def stop_is(name, want):
    name, want = (name or '').strip(), (want or '').strip()
    return bool(want) and (name == want or want.split(',', 1)[-1].strip() == name)


def is_forced(t, forced_legs, depots, forced_out_km):
    """Information only (R53): a leg the vehicle cannot avoid. A dispatcher empty is excess even if forced."""
    if t.get('empty_kind') == 'dispatcher' or not t.get('a') or not t.get('b'):
        return False
    a, b = t['a'], t['b']
    if 'depot' not in a and 'depot' not in b:
        return any(stop_is(a['name'], r['name']) and stop_is(b['name'], r['to_stop']) for r in forced_legs)
    return 'depot' in a and (t.get('our_km') or 0) > forced_out_km
