"""Build the plan-vs-actual payload of one service day (R53) and the SQL that stores it in private.pva_day.
  python -m pva.build --src <operator files folder> --day YYYY-MM-DD [--day ...] --gtfs <zip of that day> --out <dir>
The operator files stay outside the repo; the payload and SQL are written to --out (default pipeline/cache, git-ignored).
Driver names are never read (pva.read); drivers appear by code only."""
import argparse, collections, glob, json, os
from pva import read, ends, km, lessons as lessons_mod
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
    return dict(sidur=sidur, veh=e['veh'] if e else None, driver=(e['driver'] or '?') if e else None, status=t['status'],
                kind=t['kind'], empty_kind=t.get('empty_kind'), forced=t.get('forced', False),
                t0=t['t'], t1=(t['t'] + int((e['end'] - e['start']).total_seconds() // 60)) if e else None,
                mkt8=(e or p)['mkt8'], line=(e['line'] if e else p.get('line')) or None, desc=t.get('desc', ''),
                plan_t=p['dep_min'] if p else None, a=_stop(t.get('a') or t.get('first')), b=_stop(t.get('b') or t.get('last')),
                op_km=t.get('op_km'), our_km=t.get('our_km'), g_km=t.get('g_km'), verdict=t.get('verdict'),
                km_src=t.get('km_src'), end_src=t.get('end_src'), gtfs_match=t.get('gtfs_match'))


def excess_km(t):
    """Empty km beyond the plan: an added empty (dispatcher or extra), unless forced. Operator km first, else ours."""
    if t['kind'] != 'empty' or t['status'] != 'added' or (t.get('forced') and t.get('empty_kind') != 'dispatcher'):
        return 0.0
    return (t['op_km'] if t['op_km'] is not None else t['our_km']) or 0.0


def build_day(src, day, depots, forced_legs, forced_out_km, gtfs_zip, road, google, cfg):
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
    by_veh = collections.defaultdict(list)
    for t in trips:
        if t['exec']:
            by_veh[t['exec']['veh']].append(t)
    for seq in by_veh.values():
        seq.sort(key=lambda t: t['t'])
        ends.resolve(seq, depots, cfg.get('depot_alias', {}))
    for s in res['sidurim']:  # the sidur's plan order: only for trips that were not done (executed ones keep the vehicle pass)
        seq = [t for t in s['trips'] if t['status'] != 'added']
        keep = {id(t): (t.get('a'), t.get('b'), t.get('end_src')) for t in seq if t['status'] != 'not_done' and t['kind'] == 'empty'}
        ends.resolve(seq, depots, cfg.get('depot_alias', {}))
        for t in seq:
            if id(t) in keep:
                t['a'], t['b'], t['end_src'] = keep[id(t)]
    opk = {m: v[0] for m, v in rdict.items() if v[0] is not None}
    for t in trips:
        if t['kind'] == 'empty':
            km.fill(t, opk, road, google, cfg)
            t['forced'] = ends.is_forced(t, forced_legs, depots, forced_out_km)
        else:
            t['op_km'] = (t.get('plan') or {}).get('km') or opk.get(t['exec']['mkt8'] if t['exec'] else None)
    out_sid = [dict(sidur=s['sidur'], in_plan=s['in_plan'], trips=[_trip(t, s['sidur'], day) for t in s['trips']])
               for s in res['sidurim']]
    drivers = collections.defaultdict(lambda: dict(excess_km=0.0, dispatcher_km=0.0, n_excess=0, sidurim=set(), vehicles=set()))
    for s in out_sid:
        for t in s['trips']:
            if t['driver'] is None:
                continue
            d = drivers[t['driver']]; d['sidurim'].add(s['sidur']); d['vehicles'].add(t['veh'])
            x = excess_km(t)
            if x:
                d['excess_km'] += x; d['n_excess'] += 1
                if t['empty_kind'] == 'dispatcher':
                    d['dispatcher_km'] += x
    drivers = {k: dict(v, excess_km=round(v['excess_km'], 1), dispatcher_km=round(v['dispatcher_km'], 1),
                       sidurim=sorted(v['sidurim']), vehicles=sorted(v['vehicles'])) for k, v in drivers.items()}
    all_t = [t for s in out_sid for t in s['trips']]
    return dict(day=day.isoformat(), day_type=dtype, drivers=drivers, sidurim=out_sid,
                unresolved=[t for t in all_t if t['kind'] == 'empty' and t['end_src'] == 'unresolved' and t['status'] != 'not_done'],
                gaps=[t for t in all_t if t.get('verdict') in ('op', 'ours', 'third', 'pending')], lessons=[],
                pending_google=km.pending_pairs([t for t in trips if t['kind'] == 'empty']))


def upsert_sql(operator_id, payload):
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
    ap.add_argument('--google', help='google_routes.json of tools/google_route_check.py (local cache)')
    ap.add_argument('--ours', help="folder of our plaintext day files (day_<D>.json) for the lessons tab")
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'cache'))
    a = ap.parse_args()
    st = json.load(open(a.settings, encoding='utf-8'))
    g = km.google_from_cache(json.load(open(a.google, encoding='utf-8'))) if a.google else {}
    pc = json.load(open(os.path.join(km.HERE, 'config.json'), encoding='utf-8'))['pva']
    cfg = dict(km.load_cfg(), depot_alias=pc.get('depot_alias', {}), gtfs_agency=pc.get('gtfs_agency'))
    road, save, _ = bd.osrm_router(os.path.join(bd.CACHE_DIR, 'osrm_cache.json'))
    src = Source(a.src)
    for d in a.day:
        p = build_day(src, dt.date.fromisoformat(d), st['depots'], st.get('forced_legs', []), st.get('forced_out_km', 5),
                      a.gtfs, road, g, cfg)
        of = os.path.join(a.ours, f'day_{d}.json') if a.ours else None
        if of and os.path.exists(of):
            p['lessons'] = lessons_mod.lessons(json.load(open(of, encoding='utf-8')), p)
        base = os.path.join(a.out, f'pva_{d}')
        json.dump(p, open(base + '.json', 'w', encoding='utf-8'), ensure_ascii=False)
        open(base + '.sql', 'w', encoding='utf-8').write(upsert_sql(st['operator_id'], p))
        n = collections.Counter((t['status'], t['empty_kind']) for s in p['sidurim'] for t in s['trips'])
        print(d, dict(n), 'unresolved', len(p['unresolved']), 'gaps', len(p['gaps']), 'pending google', len(p['pending_google']))
    save()


if __name__ == '__main__':
    main()
