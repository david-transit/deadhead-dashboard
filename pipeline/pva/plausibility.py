"""Is a dispatcher's added empty leg plausible? (R53, David 18.11 after checking with the operator)
The base map already links sidurim; the dispatcher adds empty legs when a sidur must move (e.g. no working bus at Givat
Shaul, a spare one at Atarot: the driver takes it from Atarot and drives empty to the line). Each added leg must fit such
a scenario; an empty round trip to the same place has no reason. Looked at along the vehicle's day, over the chain of
consecutive empty legs (no service trip between) that holds the leg:
  explained          the chain ends where the vehicle's next service trip starts (within NEAR_KM)
  end_of_day         no later service trip, the chain ends at a depot
  end_of_day_review  no later service trip, the chain ends elsewhere
  round_trip         the chain returns to where it started, with no depot on the way
  via_depot          returns to where it started through a depot (maybe a bus change): for David
  inconsistent       the next service trip starts elsewhere
  unknown            an end of the chain is not known"""
import math

NEAR_KM = 0.5


def _km(a, b):
    return 111 * math.hypot(a['lat'] - b['lat'], (a['lon'] - b['lon']) * 0.85)


def _near(a, b):
    return a is not None and b is not None and _km(a, b) <= NEAR_KM


def _hm(m):
    return f'{m // 60 % 24:02d}:{m % 60:02d}'


def _nm(p):
    return p.get('name', '?') if p else '?'


def label_vehicle(trips):
    """trips: one vehicle's executed trips of the day, in time order. Sets t['plaus'] on dispatcher legs."""
    i = 0
    while i < len(trips):
        if trips[i]['kind'] != 'empty':
            i += 1; continue
        j = i
        while j + 1 < len(trips) and trips[j + 1]['kind'] == 'empty':
            j += 1
        chain, nxt = trips[i:j + 1], (trips[j + 1] if j + 1 < len(trips) else None)
        i = j + 1
        if not any(t.get('empty_kind') == 'dispatcher' for t in chain):
            continue
        # an operator leg to an unknown place before the first dispatcher leg says nothing about the dispatcher's move
        first_d = next(k for k, t in enumerate(chain) if t.get('empty_kind') == 'dispatcher')
        cut = max((k + 1 for k in range(first_d) if chain[k].get('b') is None), default=0)
        chain = chain[cut:]
        start, end = chain[0].get('a'), chain[-1].get('b')
        mids = [t.get('b') for t in chain[:-1]]
        t0 = (nxt.get('t0', nxt.get('t')) if nxt else None)
        nx = f"הנסיעה הבאה של הרכב ({_hm(t0)}) יוצאת מ{_nm(nxt.get('a'))}" if nxt and t0 is not None else ''
        if start is None or end is None or any(m is None for m in mids):
            lab, why = 'unknown', 'לא ידוע מאיפה או לאן נסעה אחת הנסיעות הריקות ברצף הזה, ואין נסיעה צמודה שממנה אפשר להסיק'
        elif len(chain) > 1 and _near(start, end):
            lab = 'via_depot' if any('depot' in m for m in mids) else 'round_trip'
            why = f"הרכב יצא מ{_nm(start)} וחזר אליו" + (f" דרך {' ← '.join(_nm(m) for m in mids)}" if mids else '') + '. אולי הוחלף רכב; צריך לברר'
        elif nxt is None:
            lab = 'end_of_day' if 'depot' in end else 'end_of_day_review'
            why = f"זו הנסיעה האחרונה של הרכב ביום, והוא נשאר ב{_nm(end)}" + ('' if 'depot' in end else ', שאינו מוסך')
        elif _near(end, nxt.get('a')):
            lab, why = 'explained', f"{nx}, בדיוק במקום שאליו הגיע"
        else:
            gap = _km(end, nxt['a']) if nxt.get('a') else None
            lab = 'inconsistent'
            why = (f"הנסיעה הריקה הסתיימה ב{_nm(end)}, אבל {nx}" + (f", כ־{gap:.0f} ק״מ משם בקו אווירי" if gap else '') +
                   '. אין נסיעה רשומה ביניהן: אולי נסיעה ריקה שלא נרשמה בדוח הביצוע, או רישום שגוי של מספר הרכב')
        for t in chain:
            if t.get('empty_kind') == 'dispatcher':
                t['plaus'], t['plaus_why'] = lab, why
                if t.get('inferred') and lab != 'unknown':  # David 19.11: a bus may arrive at one place and leave from another
                    side = 'היעד' if 'b' in t['inferred'] else 'המוצא'
                    p = t.get('b') if 'b' in t['inferred'] else t.get('a')
                    t['plaus'] = 'estimated'
                    t['plaus_why'] = (f"{side} לא נכתב בדוח הביצוע. לפי הנסיעה הריקה הצמודה זה כנראה {_nm(p)}, אבל זה חישוב ולא נתון: "
                                      'ראינו שרכב יכול להגיע למקום אחד ולצאת אחר כך ממקום אחר')
