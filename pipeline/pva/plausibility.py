"""Is a dispatcher's added empty leg plausible? (R53, David 18.11 after checking with the operator)
The base map already links sidurim; the dispatcher adds empty legs when a sidur must move (e.g. no working bus at Givat
Shaul, a spare one at Atarot: the driver takes it from Atarot and drives empty to the line). Each added leg must fit such
a scenario; an empty round trip to the same place has no reason. Looked at along the vehicle's day, over the chain of
consecutive empty legs (no service trip between) that holds the leg:
  explained          the chain ends where the vehicle's next service trip starts (within NEAR_KM)
  end_of_day         no later service trip, the chain ends at a depot
  end_of_day_review  no later service trip, the chain ends elsewhere
  round_trip         the chain returns to where it started, with no depot on the way
  via_depot          returns to where it started through a depot (maybe a bus or driver change): for David
  inconsistent       the next service trip starts elsewhere
  unknown            an end of the chain is not known"""
import math

NEAR_KM = 0.5


def _km(a, b):
    return 111 * math.hypot(a['lat'] - b['lat'], (a['lon'] - b['lon']) * 0.85)


def _near(a, b):
    return a is not None and b is not None and _km(a, b) <= NEAR_KM


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
        start, end = chain[0].get('a'), chain[-1].get('b')
        mids = [t.get('b') for t in chain[:-1]]
        if start is None or end is None or any(m is None for m in mids):
            lab = 'unknown'
        elif len(chain) > 1 and _near(start, end):
            lab = 'via_depot' if any('depot' in m for m in mids) else 'round_trip'
        elif nxt is None:
            lab = 'end_of_day' if 'depot' in end else 'end_of_day_review'
        elif _near(end, nxt.get('a')):
            lab = 'explained'
        else:
            lab = 'inconsistent'
        for t in chain:
            if t.get('empty_kind') == 'dispatcher':
                t['plaus'] = lab
