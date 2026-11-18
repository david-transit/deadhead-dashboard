"""Synthetic operator files for tests (no real data)."""
import openpyxl, os, tempfile, datetime as dt

PLAN_HDR = ['סמל תקופה', 'סידור עבודה', 'סוג סידור', '  שעת התחלה', 'שעת יציאה', 'מקט', 'מקט8', 'סוג נסיעה', 'שילוט',
            'תיאור נסיעה', 'קמ', 'מזן תשלום', 'מזן ריאלי', 'סוג רכב']
EXEC_HDR = ['זיהוי', 'מזהה משהת', 'סוג', 'תחילה', 'סיום', 'סידור', 'מסלול', 'קו', 'רישוי', 'קוד נהג', 'פרטי', 'משפחה']


def plan_xlsx(rows):
    """rows: dicts with keys sidur, t (HMM), kind (שרות/ריקה/אלמנט), mkt8, line, desc, km, real, vtype"""
    wb = openpyxl.Workbook(); ws = wb.active; ws.append(PLAN_HDR)
    for r in rows:
        ws.append([4026, r['sidur'], 'משמרת', 500, r['t'], int(r['mkt8']) // 100, r['mkt8'], r['kind'], r.get('line'),
                   r.get('desc', ''), r.get('km'), 1, r.get('real'), r.get('vtype')])
    p = os.path.join(tempfile.mkdtemp(), 'plan.xlsx'); wb.save(p); return p


def exec_xlsx(rows):
    """rows: dicts with keys id, kind (שירות/ריקה), start, end (datetime), sidur, mkt8, line, veh, driver, first, last"""
    wb = openpyxl.Workbook(); ws = wb.active; ws.append(['Schedule'] + [None] * 11); ws.append(EXEC_HDR)
    for r in rows:
        ws.append([r['id'], None, r['kind'], r['start'], r['end'], str(r['sidur']), str(r['mkt8']), r.get('line', 0),
                   r['veh'], r.get('driver'), r.get('first', 'שםפרטי'), r.get('last', 'שםמשפחה')])
    p = os.path.join(tempfile.mkdtemp(), 'exec.xlsx'); wb.save(p); return p


D = dt.datetime
