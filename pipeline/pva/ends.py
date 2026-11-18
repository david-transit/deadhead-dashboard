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


def route_ends(gtfs_zip, mkt8s, lines=None, agency=None):
    """key (makat-direction) -> (first stop, last stop, how). how='makat': the MOT route_desc has the operator's makat.
    how='line': the operator's internal makat is not at the MOT (e.g. 33139 vs 16139 for line 139); matched by the
    operator's agency, the line number and the direction digit instead (lines: mkt8 -> line)."""
    want = {gtfs_key(m) for m in mkt8s}
    by_line = {(str(lines[m]), gtfs_key(m).split('-')[1]): gtfs_key(m) for m in mkt8s if lines and lines.get(m)}
    z = zipfile.ZipFile(gtfs_zip)
    rd = lambda n: csv.DictReader(io.TextIOWrapper(z.open(n), encoding='utf-8-sig'))
    rt, alt = {}, {}
    for r in rd('routes.txt'):
        k = '-'.join(r['route_desc'].split('-')[:2])
        if k in want:
            rt[r['route_id']] = (k, 'makat')
        elif agency and r['agency_id'] == agency and (r['route_short_name'], k.split('-')[-1]) in by_line:
            alt[r['route_id']] = (by_line[(r['route_short_name'], k.split('-')[-1])], 'line')
    have = {v[0] for v in rt.values()}
    rt.update({rid: v for rid, v in alt.items() if v[0] not in have})
    trips = {r['trip_id']: rt[r['route_id']] for r in rd('trips.txt') if r['route_id'] in rt}
    fl = {}
    for r in rd('stop_times.txt'):
        t = r['trip_id']
        if t in trips:
            s = int(r['stop_sequence']); a = fl.setdefault(t, [10 ** 9, None, -1, None])
            if s < a[0]: a[0], a[1] = s, r['stop_id']
            if s > a[2]: a[2], a[3] = s, r['stop_id']
    cnt = collections.defaultdict(lambda: (collections.Counter(), collections.Counter()))
    how = {}
    for t, a in fl.items():
        k, h = trips[t]; how[k] = h
        cnt[k][0][a[1]] += 1; cnt[k][1][a[3]] += 1
    need = {s for c in cnt.values() for x in c for s in x}
    st = {r['stop_id']: dict(code=r['stop_code'], name=r['stop_name'], lat=float(r['stop_lat']), lon=float(r['stop_lon']))
          for r in rd('stops.txt') if r['stop_id'] in need}
    return {k: (st[c[0].most_common(1)[0][0]], st[c[1].most_common(1)[0][0]], how[k]) for k, c in cnt.items()}


def annotate_service(trips, rends):
    """Set first / last stop on service trips from route_ends() output."""
    for t in trips:
        if t['kind'] == 'service':
            mk = (t.get('exec') or t.get('plan'))['mkt8']
            fl = rends.get(gtfs_key(mk))
            t['first'], t['last'], t['gtfs_match'] = fl if fl else (None, None, None)


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
        # a depot named in the description is a definite place (also mid-day); otherwise the neighbouring service trip
        a = _depot(desc, depots, aliases, True) or (prv.get('last') if prv and prv['kind'] == 'service' else None)
        b = _depot(desc, depots, aliases, False) or (nxt.get('first') if nxt and nxt['kind'] == 'service' else None)
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
