"""Execution vs plan for one service day (R53). A sidur is a driver's duty; the execution report is the leading schedule.
Matching: same sidur and route code (מקט8), nearest planned minute, each plan row used once.
  0 min -> planned, 1..CHANGE_MAX min -> changed, no plan row within CHANGE_MAX -> added.
Plan rows of an executed sidur that nothing matched -> not_done. A sidur missing from the plan -> every row added;
its empty rows are 'dispatcher' (counted as excess, flagged apart). An added empty inside a planned sidur is 'extra'."""
import collections
import datetime as dt

CHANGE_MAX = 60
TRIP_KINDS = ('service', 'empty')


def exec_minute(row, day):
    return int((row['start'] - dt.datetime.combine(day, dt.time())).total_seconds() // 60)


def classify(plan_rows, exec_rows, day):
    plan = collections.defaultdict(list)
    for p in plan_rows:
        if p['kind'] in TRIP_KINDS:
            plan[p['sidur']].append(p)
    ex = collections.defaultdict(list)
    for e in exec_rows:
        ex[e['sidur']].append(e)
    sidurim, unplanned = [], []
    for sid, rows in ex.items():
        rows = sorted(rows, key=lambda e: e['start'])
        in_plan = sid in plan
        if not in_plan:
            unplanned.append(sid)
        free = list(plan.get(sid, []))
        trips = []
        for e in rows:
            m = exec_minute(e, day)
            cands = [p for p in free if p['mkt8'] == e['mkt8'] and abs(p['dep_min'] - m) <= CHANGE_MAX]
            p = min(cands, key=lambda p: abs(p['dep_min'] - m)) if cands else None
            if p is not None:
                free.remove(p)
                status = 'planned' if p['dep_min'] == m else 'changed'
                ek = 'planned' if e['kind'] == 'empty' else None
            else:
                status = 'added'
                ek = ('dispatcher' if not in_plan else 'extra') if e['kind'] == 'empty' else None
            trips.append(dict(status=status, kind=e['kind'], empty_kind=ek, plan=p, exec=e, t=m))
        for p in free:
            trips.append(dict(status='not_done', kind=p['kind'], empty_kind='planned' if p['kind'] == 'empty' else None,
                              plan=p, exec=None, t=p['dep_min']))
        trips.sort(key=lambda t: t['t'])
        sidurim.append(dict(sidur=sid, in_plan=in_plan, trips=trips))
    sidurim.sort(key=lambda s: (not s['in_plan'], s['sidur']))
    return dict(sidurim=sidurim, unplanned_sidurim=sorted(unplanned))
