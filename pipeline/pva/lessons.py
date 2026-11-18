"""Lessons (R53): what our own guess (the dashboard's day built from Open Bus) got wrong against what the operator did.
An empty leg of ours and of the operator are the same leg when they belong to the same vehicle and lead into the same
next service trip (our empty ends at the next trip's start; the operator's next service trip starts within MATCH_MIN).
  other_destination: the same leg, but we send the bus elsewhere (ends more than FAR_KM apart)
  missing_in_ours:   an operator empty leg with no leg of ours (mostly dispatcher / depot legs)
  km_gap:            operator vs our km on the operator's legs, by Google verdict"""
import collections, math

MATCH_MIN = 10
FAR_KM = 0.3


def _km(a, b):
    return 111 * math.hypot(a[0] - b[0], (a[1] - b[1]) * 0.85)


def _seq(pva):
    by = collections.defaultdict(list)
    for s in pva['sidurim']:
        for t in s['trips']:
            if t['status'] != 'not_done' and t.get('veh') is not None:
                by[t['veh']].append(t)
    for L in by.values():
        L.sort(key=lambda t: t['t0'])
    return by


def lessons(ours, pva):
    seq = _seq(pva)
    our_by = {int(v['veh']): v['items'] for v in ours.get('vehicles', [])}
    other, missing, via, used = [], [], [], set()
    for veh, L in seq.items():
        items = our_by.get(int(veh), [])
        i = 0
        while i < len(L):
            if L[i]['kind'] != 'empty':
                i += 1; continue
            j = i
            while j + 1 < len(L) and L[j + 1]['kind'] == 'empty':
                j += 1
            chain, nxt = L[i:j + 1], (L[j + 1] if j + 1 < len(L) else None)
            i = j + 1
            m = None
            if nxt:
                m = next((e for e in items if e['kind'] == 'empty' and id(e) not in used and abs(e['end'] - nxt['t0']) <= MATCH_MIN), None)
            if m is None:
                missing += [dict(veh=veh, t0=t['t0'], sidur=t['sidur'], op=t.get('desc', ''), kind=t.get('empty_kind')) for t in chain]
                continue
            used.add(id(m))
            first, last = chain[0], chain[-1]
            if len(chain) > 1:
                via.append(dict(veh=veh, t0=first['t0'], sidur=first['sidur'], via=' ← '.join(t['b']['name'] if t.get('b') else '?' for t in chain[:-1]),
                                op=' / '.join(t.get('desc', '') for t in chain), ours=f"{m.get('frm', '')} ← {m.get('to', '')}"))
            elif last.get('b') and m.get('b') and _km([last['b']['lat'], last['b']['lon']], m['b']) > FAR_KM:
                other.append(dict(veh=veh, t0=first['t0'], sidur=first['sidur'], op=f"{first['a']['name'] if first.get('a') else '?'} ← {last['b']['name']}",
                                  ours=f"{m.get('frm', '')} ← {m.get('to', '')}"))
    gaps = [t for L in seq.values() for t in L if t['kind'] == 'empty' and t.get('verdict') in ('op', 'ours', 'third')]
    pairs = collections.Counter((t.get('desc', ''), t['verdict']) for t in gaps)
    return [
        dict(type='via_stop', count=len(via), examples=via[:5],
             why='המפעיל מחלק את המעבר לכמה נסיעות ריקות (דרך מוסך או חניון ביניים); אנחנו רואים רק נסיעה ישירה לנסיעה הבאה'),
        dict(type='other_destination', count=len(other), examples=other[:5],
             why='אנחנו מסיקים את היעד מהנסיעה הבאה שה־GPS ראה; המפעיל שולח את הרכב קודם לתחנת יציאה קבועה או לחניון ביניים'),
        dict(type='missing_in_ours', count=len(missing), by_kind=dict(collections.Counter(x['kind'] for x in missing)), examples=missing[:5],
             why='רכב ריק לא משדר, ולכן נסיעות של סדרן, יציאות מהמוסך וחזרות אליו לא נראות ב־Open Bus'),
        dict(type='km_gap', count=len(gaps), by_verdict=dict(collections.Counter(t['verdict'] for t in gaps)),
             examples=[dict(desc=d, verdict=v, n=n) for (d, v), n in pairs.most_common(5)],
             why='הפער בין הק״מ של המפעיל לניתוב שלנו, וההכרעה של גוגל'),
    ]
