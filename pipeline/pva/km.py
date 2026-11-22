"""Km of each trip (R53): the operator's km (base map, by route code מקט8) is primary, ours (OSRM road, as in the main
dashboard) beside it. A gap is more than gap_km AND more than gap_pct: 'third' (manual check with David). No Google
result is used or kept (Maps terms, David 22.11.2026). Thresholds: pipeline/config.json "pva"."""
import json, os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_cfg():
    c = json.load(open(os.path.join(HERE, 'config.json'), encoding='utf-8'))['pva']
    return {k: c[k] for k in ('gap_km', 'gap_pct')}


def pair_key(a, b):
    return f"{a['lat']:.5f},{a['lon']:.5f};{b['lat']:.5f},{b['lon']:.5f}"


def verdict(op, ours, cfg):
    if op is None or ours is None:
        return 'n/a'
    d = abs(op - ours)
    if not (d > cfg['gap_km'] and op and d / op * 100 > cfg['gap_pct']):
        return 'match'
    return 'third'


def fill(t, op_km_by_mkt8, road, cfg):
    mk = (t.get('exec') or t.get('plan'))['mkt8']
    op = (t.get('plan') or {}).get('km')
    t['op_km'] = op if op is not None else op_km_by_mkt8.get(mk)
    a, b = t.get('a'), t.get('b')
    t['our_km'] = None
    if a and b:
        t['our_km'] = road([round(a['lat'], 5), round(a['lon'], 5)], [round(b['lat'], 5), round(b['lon'], 5)], (True, True))[0]
    t['km_src'] = 'op' if t['op_km'] is not None else 'ours'
    t['verdict'] = verdict(t['op_km'], t['our_km'], cfg)
