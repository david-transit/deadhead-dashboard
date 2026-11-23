"""Read the operator's base map (plan) and execution report. Columns are found by header name.
No driver data is read: not the code (קוד נהג), not the names (פרטי, משפחה). A trip is known by its sidur and vehicle
only (R53, David 23.11). The sidur column is required: without it the file is rejected."""
import datetime as dt, os
import openpyxl

PLAN_KIND = {'שרות': 'service', 'ריקה': 'empty', 'אלמנט': 'element', 'ניהול תנועה': 'mgmt'}
EXEC_KIND = {'שירות': 'service', 'ריקה': 'empty'}


def hmm_to_min(h):
    h = int(h)
    return h // 100 * 60 + h % 100


def service_day(t, start_h=4):
    return (t - dt.timedelta(hours=start_h)).date()


def day_type(d):
    return {4: 'fri', 5: 'sat'}.get(d.weekday(), 'weekday')


def _num(v):
    return None if v in (None, '', ' ') else v


def _rows(path, header_row):
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[0]
    it = ws.iter_rows(values_only=True)
    for _ in range(header_row - 1):
        next(it)
    col = {str(h).strip(): i for i, h in enumerate(next(it)) if h is not None}
    for r in it:
        if any(v not in (None, '') for v in r):
            yield col, r


def read_plan(path):
    out = []
    for c, r in _rows(path, 1):
        g = lambda k: r[c[k]]
        line = _num(g('שילוט'))
        out.append(dict(sidur=str(g('סידור עבודה')), dep_min=hmm_to_min(g('שעת יציאה')), kind=PLAN_KIND[g('סוג נסיעה')],
                        mkt8=str(g('מקט8')), line=int(line) if line is not None else None,
                        desc=str(g('תיאור נסיעה') or '').strip(), km=_num(g('קמ')), real_min=_num(g('מזן ריאלי')),
                        vtype=_num(g('סוג רכב'))))
    return out


def read_exec(path):
    out = []
    for c, r in _rows(path, 2):
        if 'סידור' not in c:
            raise SystemExit(f'{os.path.basename(path)}: אין עמודת "סידור" בדוח הביצוע. בלי מספר סידור אי אפשר לחשב תכנון מול ביצוע')
        g = lambda k: r[c[k]]
        sidur = g('סידור')
        if sidur in (None, '') or not str(sidur).strip():
            raise SystemExit(f'{os.path.basename(path)}: בשורה {g("זיהוי")} של דוח הביצוע אין מספר סידור. בלי מספר סידור אי אפשר לחשב תכנון מול ביצוע')
        out.append(dict(id=int(g('זיהוי')), kind=EXEC_KIND[g('סוג')], start=g('תחילה'), end=g('סיום'), sidur=str(sidur).strip(),
                        mkt8=str(g('מסלול')), line=int(g('קו') or 0), veh=int(g('רישוי'))))
    if not out:
        raise SystemExit(f'{os.path.basename(path)}: דוח הביצוע ריק')
    return out


def urban_sidurim(plan_rows):
    inter = {r['sidur'] for r in plan_rows if r.get('vtype') == 'בין-עירוני'}
    return {r['sidur'] for r in plan_rows} - inter
