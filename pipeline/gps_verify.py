"""Route warnings checked against real GPS (PRD-deadhead R51, David 22.11.2026; Google's results may not be used).

An empty leg A -> B with a road warning is measured on the day's SIRI traces of buses in service that drove the same
stretch: a trace that passes within near_km of A and later within near_km of B (same direction, within max_min) gives the
km it drove between them: its distance along the journey (SIRI distance_from_journey_start) between the two points,
corrected by how far each point is from A / B along the way; without that distance, the sum of the GPS steps. The
median over the passages is the "km in practice". Close to ours (|ours - practice| <= max(tol_pct %, tol_km)) = "אומת
מול נסיעות בפועל"; otherwise, or with no passage, the warning stays for a manual check. Settings: pipeline/config.json
"gps_verify". Only km are compared; nothing from Google is used or kept."""
import bisect, datetime as dt, math, statistics

DEF = dict(enabled=True, near_km=0.3, max_min=90, min_passes=1, max_passes=15, tol_pct=15, tol_km=0.5)


def hav(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0]); dp, dl = p2 - p1, math.radians(b[1] - a[1])
    return 2 * 6371 * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def _mins(s):
    return dt.datetime.fromisoformat(s).timestamp() / 60


def _closest(tr, p, lo, hi, near_km):
    """index of the trace point nearest p in tr[lo:hi], if within near_km (a local minimum: the bus passing by)"""
    best, bi = near_km, None
    for k in range(lo, hi):
        d = hav((tr[k][1], tr[k][2]), p)
        if d <= best: best, bi = d, k
        elif bi is not None and d > best + 1.0: break  # moved away again: this passage is over
    return bi


def _offset(tr, k, p):
    """km from trace point k to p along the way: + when p is ahead of the point (between it and the next), else -"""
    d = hav((tr[k][1], tr[k][2]), p)
    if k + 1 < len(tr):
        nxt = (tr[k + 1][1], tr[k + 1][2])
        return d if hav(p, nxt) < hav((tr[k][1], tr[k][2]), nxt) else -d
    return -d


def passage_km(tr, i, j):
    """km driven from trace point i to j: SIRI distance along the journey when both have it and it grows, else the GPS steps"""
    di, dj = tr[i][3], tr[j][3]
    if di is not None and dj is not None and dj >= di:
        return (dj - di) / 1000
    return sum(hav((tr[k][1], tr[k][2]), (tr[k + 1][1], tr[k + 1][2])) for k in range(i, j))


def passes(traces, a, b, cfg=DEF):
    """km of each passage A -> B in the traces ({ride: [[iso, lat, lon, dist_m], ...]}), up to max_passes"""
    out, nk = [], cfg["near_km"]
    box = lambda p: (p[0] - 0.01, p[0] + 0.01, p[1] - 0.012, p[1] + 0.012)
    ba = box(a)
    for tr in traces.values():
        if len(tr) < 2: continue
        k0 = 0
        while k0 < len(tr) and len(out) < cfg["max_passes"]:
            ka = next((k for k in range(k0, len(tr)) if ba[0] <= tr[k][1] <= ba[1] and ba[2] <= tr[k][2] <= ba[3]), None)
            if ka is None: break
            i = _closest(tr, a, ka, min(len(tr), ka + 6), nk)
            if i is None: k0 = ka + 1; continue
            t0 = _mins(tr[i][0]); hi = i + 1
            while hi < len(tr) and _mins(tr[hi][0]) - t0 <= cfg["max_min"]: hi += 1
            j = _closest(tr, b, i + 1, hi, nk)
            if j is not None:
                km = passage_km(tr, i, j) - _offset(tr, i, a) + _offset(tr, j, b)
                if km > 0: out.append(round(km, 2))
                k0 = j + 1
            else:
                k0 = i + 1
    return out


def verify(traces, a, b, ours, cfg=DEF):
    """[median km in practice, passages, close?] or None (no passage: stays for a manual check)"""
    ps = passes(traces, a, b, cfg)
    if len(ps) < cfg["min_passes"]: return None
    m = round(statistics.median(ps), 2)
    return [m, len(ps), abs(m - ours) <= max(cfg["tol_pct"] / 100 * ours, cfg["tol_km"])]
