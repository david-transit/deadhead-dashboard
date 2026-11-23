"""Build the plan-vs-actual payload of one service day (R53) and the SQL that stores it in private.pva_day.
  python -m pva.build --src <operator files folder> --day YYYY-MM-DD [--day ...] --gtfs <zip of that day> --out <dir>
The operator files stay outside the repo; the payload and SQL are written to --out (default pipeline/cache, git-ignored).
No driver data at all (David 23.11): pva.read does not read the driver code or names; totals are by sidur and vehicle."""
import argparse, collections, glob, json, os
from pva import read, ends, km, lessons as lessons_mod, plausibility, seal
from pva.classify import classify

PLAN_FILES = dict(weekday='בסיס א-ה', fri='בסיס שישי', sat='בסיס שבת')


class Source:
    """The operator's files in one folder: base maps by day type and the execution report (read once)."""

    def __init__(self, folder):
        self.folder = folder
        self._plans = {}
        self.exec = read.read_exec(self._find('ביצוע'))

    def _find(self, part):
        f = [p for p in glob.glob(os.path.join(self.folder, '*.xlsx')) if part in os.path.basename(p)]
        if len(f) != 1:
            raise SystemExit(f'expected one file with "{part}" in {self.folder}, found {len(f)}')
        return f[0]

    def plan(self, dtype):
        if dtype not in self._plans:
            self._plans[dtype] = read.read_plan(self._find(PLAN_FILES[dtype]))
        return self._plans[dtype]

    def route_dict(self):
        """route code -> (operator km, description), from every base map present."""
        out = {}
        for dt_ in PLAN_FILES:
            try:
                rows = self.plan(dt_)
            except SystemExit:
                continue
            for r in rows:
                out.setdefault(r['mkt8'], (r['km'], r['desc']))
        return out


def _stop(s):
    return None if s is None else {k: s[k] for k in ('code', 'name', 'lat', 'lon', 'depot') if k in s}


def _trip(t, sidur, day):
    e, p = t.get('exec'), t.get('plan')
    return dict(sidur=sidur, veh=e['veh'] if e else None, status=t['status'],
                kind=t['kind'], empty_kind=t.get('empty_kind'), forced=t.get('forced', False),
                t0=t['t'], t1=(t['t'] + int((e['end'] - e['start']).total_seconds() // 60)) if e else None,
                mkt8=(e or p)['mkt8'], line=(e['line'] if e else p.get('line')) or None, desc=t.get('desc', ''),
                plan_t=p['dep_min'] if p else None, a=_stop(t.get('a') or t.get('first')), b=_stop(t.get('b') or t.get('last')),
                op_km=t.get('op_km'), our_km=t.get('our_km'), verdict=t.get('verdict'),
                km_src=t.get('km_src'), end_src=t.get('end_src'), inferred=t.get('inferred'), gtfs_match=t.get('gtfs_match'), plaus=t.get('plaus'), plaus_why=t.get('plaus_why'), geom=t.get('geom'))


def thin(pts, min_m=15):
    """Drop points closer than min_m to the last kept one (keeps both ends): a lighter drawn road, same shape."""
    import math
    out = [pts[0]]
    for p in pts[1:-1]:
        if 111000 * math.hypot(p[0] - out[-1][0], (p[1] - out[-1][1]) * 0.85) >= min_m:
            out.append(p)
    return out + [pts[-1]] if len(pts) > 1 else out


def excess_km(t):
    """Empty km beyond the plan: an added empty (dispatcher or extra), unless forced. Operator km first, else ours."""
    if t['kind'] != 'empty' or t['status'] != 'added' or (t.get('forced') and t.get('empty_kind') != 'dispatcher'):
        return 0.0
    return (t['op_km'] if t['op_km'] is not None else t['our_km']) or 0.0


def totals(out_sid):
    """Excess empty km of the day by sidur and by vehicle (R53 "ק״מ בלי הסבר"). Keys are strings (JSON object keys)."""
    new = lambda: dict(excess_km=0.0, dispatcher_km=0.0, n_excess=0, other=set())
    sid, veh = collections.defaultdict(new), collections.defaultdict(new)
    for s in out_sid:
        for t in s['trips']:
            rows = [(sid[str(s['sidur'])], t['veh'])]
            if t['veh'] is not None:
                rows.append((veh[str(t['veh'])], s['sidur']))
            x = excess_km(t)
            for d, o in rows:
                if o is not None:
                    d['other'].add(o)
                if x:
                    d['excess_km'] += x; d['n_excess'] += 1
                    if t['empty_kind'] == 'dispatcher':
                        d['dispatcher_km'] += x
    fin = lambda m, name: {k: dict(excess_km=round(v['excess_km'], 1), dispatcher_km=round(v['dispatcher_km'], 1), n_excess=v['n_excess'],
                                   **{name: sorted(v['other'], key=str)}) for k, v in m.items()}
    return fin(sid, 'vehicles'), fin(veh, 'sidurim')


def build_day(src, day, depots, forced_legs, forced_out_km, gtfs_zip, road, cfg):
    dtype = read.day_type(day)
    plan = src.plan(dtype)
    urban = read.urban_sidurim(plan)
    inter = {r['sidur'] for r in plan} - urban
    plan = [r for r in plan if r['sidur'] in urban]
    ex = [e for e in src.exec if read.service_day(e['start']) == day and e['sidur'] not in inter]
    res = classify(plan, ex, day)
    rdict = src.route_dict()
    trips = [t for s in res['sidurim'] for t in s['trips']]
    for t in trips:
        t['desc'] = ((t.get('plan') or {}).get('desc') or rdict.get((t['exec'] or t['plan'])['mkt8'], (None, ''))[1] or '')
    svc = {(t['exec'] or t['plan'])['mkt8']: (t['exec'] or t['plan'])['line'] for t in trips if t['kind'] == 'service'}
    ends.annotate_service(trips, ends.route_ends(gtfs_zip, set(svc), lines=svc, agency=cfg.get('gtfs_agency')))
    learned = ends.learn_places(trips)
    fixed = {n: v for n, v in cfg.get('places', {}).items() if not n.startswith('_')}
    places = {**learned, **fixed}
    by_veh = collections.defaultdict(list)
    for t in trips:
        if t['exec']:
            by_veh[t['exec']['veh']].append(t)
    for seq in by_veh.values():
        seq.sort(key=lambda t: t['t'])
        ends.resolve(seq, depots, cfg.get('depot_alias', {}), places)
    for s in res['sidurim']:  # the sidur's plan order: only for trips that were not done (executed ones keep the vehicle pass)
        seq = [t for t in s['trips'] if t['status'] != 'added']
        keep = {id(t): (t.get('a'), t.get('b'), t.get('end_src')) for t in seq if t['status'] != 'not_done' and t['kind'] == 'empty'}
        ends.resolve(seq, depots, cfg.get('depot_alias', {}), places)
        for t in seq:
            if id(t) in keep:
                t['a'], t['b'], t['end_src'] = keep[id(t)]
    opk = {m: v[0] for m, v in rdict.items() if v[0] is not None}
    for t in trips:
        if t['kind'] == 'empty':
            km.fill(t, opk, road, cfg)
            t['forced'] = ends.is_forced(t, forced_legs, depots, forced_out_km)
            g = getattr(road, 'geom', None)
            if t['status'] == 'added' and g and t.get('a') and t.get('b'):  # the map draws this road and shows its km (R13)
                r = g([round(t['a']['lat'], 5), round(t['a']['lon'], 5)], [round(t['b']['lat'], 5), round(t['b']['lon'], 5)])
                if r and r[1]:
                    t['geom'] = thin([[round(x[0], 5), round(x[1], 5)] for x in r[1]])
                    t['our_km'] = round(r[0], 2)
                    t['verdict'] = km.verdict(t['op_km'], t['our_km'], cfg)
        else:
            t['op_km'] = (t.get('plan') or {}).get('km') or opk.get(t['exec']['mkt8'] if t['exec'] else None)
    for seq in by_veh.values():  # dispatcher legs: does the vehicle's day explain them?
        for t in seq:
            if t['kind'] == 'service':
                t.setdefault('a', t.get('first')); t.setdefault('b', t.get('last'))
        plausibility.label_vehicle(seq)
    out_sid = [dict(sidur=s['sidur'], in_plan=s['in_plan'], trips=[_trip(t, s['sidur'], day) for t in s['trips']])
               for s in res['sidurim']]
    by_sidur, by_veh_km = totals(out_sid)
    all_t = [t for s in out_sid for t in s['trips']]
    return dict(day=day.isoformat(), day_type=dtype, by_sidur=by_sidur, by_vehicle=by_veh_km, sidurim=out_sid,
                unresolved=[t for t in all_t if t['kind'] == 'empty' and t['end_src'] == 'unresolved' and t['status'] != 'not_done'],
                gaps=[t for t in all_t if t.get('verdict') == 'third'], lessons=[],
                places=sorted([dict(name=n, stop=v.get('name'), code=v.get('code'), lat=v['lat'], lon=v['lon'], src='fixed' if n in fixed else 'learned') for n, v in places.items()], key=lambda x: x['name']))


def driver_keys(o, path='$'):
    """Every path in the payload whose key names a driver (driver, drivers, driver_code...). Must be empty (David 23.11)."""
    if isinstance(o, dict):
        return [x for k, v in o.items() for x in ([f'{path}.{k}'] if 'driver' in str(k).lower() else []) + driver_keys(v, f'{path}.{k}')]
    if isinstance(o, list):
        return [x for i, v in enumerate(o) for x in driver_keys(v, f'{path}[{i}]')]
    return []


def upsert_sql(operator_id, payload):
    if driver_keys(payload):
        raise SystemExit(f'driver data in the payload: {driver_keys(payload)[:5]}')
    body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).replace("'", "''")
    return (f"insert into private.pva_day (operator_id, day, payload, built) values ('{operator_id}', '{payload['day']}', "
            f"'{body}'::jsonb, now()) on conflict (operator_id, day) do update set payload = excluded.payload, built = now();\n")


def main():
    import datetime as dt, sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import build_day as bd
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True); ap.add_argument('--day', action='append', required=True)
    ap.add_argument('--gtfs', required=True, help='GTFS zip of that day (R48); one day per run when days differ')
    ap.add_argument('--settings', required=True, help='json: {operator_id, depots, forced_legs, forced_out_km}')
    ap.add_argument('--ours', help="folder of our plaintext day files (day_<D>.json) for the lessons tab")
    ap.add_argument('--op', default='derech-egged', help='operator slug: data/<op>/ holds the blind reconstruction to seal')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'cache'))
    a = ap.parse_args()
    st = json.load(open(a.settings, encoding='utf-8'))
    pc = json.load(open(os.path.join(km.HERE, 'config.json'), encoding='utf-8'))['pva']
    cfg = dict(km.load_cfg(), depot_alias=pc.get('depot_alias', {}), gtfs_agency=pc.get('gtfs_agency'))
    road, save, _ = bd.osrm_router(os.path.join(bd.CACHE_DIR, 'osrm_cache.json'))
    # OP-DATA-7: seal the blind reconstruction of every day (commit + push) BEFORE any operator file is opened
    seal.seal_days(a.day, a.op)
    opened_at = dt.datetime.now(dt.timezone.utc)
    src = Source(a.src)
    for d in a.day:
        p = build_day(src, dt.date.fromisoformat(d), st['depots'], st.get('forced_legs', []), st.get('forced_out_km', 5),
                      a.gtfs, road, cfg)
        v = seal.verify(d, a.op, opened_at)  # the extra check after opening
        p.update(blind=v['blind'], blind_why=v['why'], seal=v['seal'])
        if not v['blind']:
            print(d, 'NOT BLIND:', v['why'])
        of = os.path.join(a.ours, f'day_{d}.json') if a.ours else None
        if of and os.path.exists(of):
            p['lessons'] = lessons_mod.lessons(json.load(open(of, encoding='utf-8')), p)
        if driver_keys(p):
            raise SystemExit(f'{d}: driver data in the payload: {driver_keys(p)[:5]}')
        base = os.path.join(a.out, f'pva_{d}')
        json.dump(p, open(base + '.json', 'w', encoding='utf-8'), ensure_ascii=False)
        open(base + '.sql', 'w', encoding='utf-8').write(upsert_sql(st['operator_id'], p))
        n = collections.Counter((t['status'], t['empty_kind']) for s in p['sidurim'] for t in s['trips'])
        print(d, dict(n), 'unresolved', len(p['unresolved']), 'gaps', len(p['gaps']))
    save()


if __name__ == '__main__':
    main()
