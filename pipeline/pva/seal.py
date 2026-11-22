"""Blind seal (OP-DATA-7, ADR-0010 interim procedure, David 22.11.2026).

Before an operator file of a service day is opened, the SHA-256 of every file of that day's blind reconstruction
(the nightly pipeline's day file, data/<operator>/day_<D>.js) is written to seals/<operator>/<D>.json and pushed:
the commit on GitHub is the external timestamp. Only hashes, never data.
After the files are read, verify() hashes the reconstruction again and compares: no seal, a different hash,
a seal that is not on GitHub or is later than the opening, or a day read before the procedure -> "not blind",
and the day does not count in gate A metrics (gate_a_eligible)."""
import datetime as dt, glob, hashlib, json, os, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # the dashboard repo


class SealError(SystemExit):
    pass


def policy(root=ROOT):
    with open(os.path.join(root, 'seals', 'policy.json'), encoding='utf-8') as fh:
        return json.load(fh)


def sha256(path):
    # line endings normalised, so a Windows checkout (autocrlf) hashes like the file on GitHub
    with open(path, 'rb') as fh:
        return hashlib.sha256(fh.read().replace(b'\r\n', b'\n')).hexdigest()


def blind_files(day, op, root=ROOT):
    files = sorted(glob.glob(os.path.join(root, 'data', op, f'day_{day}.js')))
    if not files:
        raise SealError(f'{day}: no blind reconstruction (data/{op}/day_{day}.js) to seal; build the day first')
    return files


def seal_path(day, op, root=ROOT):
    return os.path.join(root, 'seals', op, f'{day}.json')


def locked(day, root=ROOT):
    a, b = policy(root)['locked']
    return a <= str(day) <= b


def _git(root, *args):
    return subprocess.run(['git', '-C', root, *args], check=True, capture_output=True, text=True).stdout.strip()


def seal_days(days, op, root=ROOT, push=True, now=None):
    """Write the seal of every day that has none yet, commit and push. Refuses the engine's locked period.
    Returns the paths sealed now. Raises SealError (nothing is opened) if anything fails."""
    days = [str(d) for d in days]
    bad = [d for d in days if locked(d, root)]
    if bad:
        raise SealError(f'locked period (engine test): operator files are not opened for {", ".join(bad)}')
    now = now or dt.datetime.now(dt.timezone.utc)
    new = []
    for d in days:
        p = seal_path(d, op, root)
        if os.path.exists(p):
            continue  # the first seal stands; verify() compares against it
        rec = dict(day=d, operator=op, sealed_at=now.isoformat(timespec='seconds'),
                   files=[dict(path=os.path.relpath(f, root).replace(os.sep, '/'), sha256=sha256(f)) for f in blind_files(d, op, root)])
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8', newline='\n') as fh:  # closed (flushed) before git add
            json.dump(rec, fh, ensure_ascii=False, indent=1)
        new.append(p)
    if new:
        try:
            _git(root, 'add', *new)
            _git(root, 'commit', '-m', f'seal: {op} {" ".join(days)} (blind reconstruction hashes, OP-DATA-7)', '--', *new)
            if push:
                _git(root, 'push', 'origin', 'HEAD')
        except subprocess.CalledProcessError as e:
            raise SealError(f'seal was not committed/pushed, operator files stay closed: {e.stderr or e}')
    return new


def _seal_commit(path, root, remote):
    """(sha, commit time) of the commit that added the seal, on the remote branch (i.e. on GitHub)."""
    rel = os.path.relpath(path, root).replace(os.sep, '/')
    ref = 'HEAD'
    if remote:
        _git(root, 'fetch', '-q', 'origin')
        ref = '@{u}'
    out = _git(root, 'log', '--diff-filter=A', '--format=%H %cI', ref, '--', rel)
    if not out:
        return None, None
    sha, t = out.splitlines()[-1].split(' ', 1)
    return sha, dt.datetime.fromisoformat(t)


def verify(day, op, opened_at, root=ROOT, remote=True):
    """Check after opening. Returns dict(blind, why, seal) for the day's payload."""
    day = str(day)
    if day <= policy(root)['not_blind_through']:
        return dict(blind=False, why='נקרא לפני 22.11 (לפני נוהל החתימה)', seal=None)
    p = seal_path(day, op, root)
    if not os.path.exists(p):
        return dict(blind=False, why='אין חתימה לשחזור העיוור', seal=None)
    with open(p, encoding='utf-8') as fh:
        rec = json.load(fh)
    try:
        now = {os.path.relpath(f, root).replace(os.sep, '/'): sha256(f) for f in blind_files(day, op, root)}
    except SealError:
        now = {}
    if now != {f['path']: f['sha256'] for f in rec['files']}:
        return dict(blind=False, why='השחזור העיוור שונה מהחתימה', seal=None)
    sha, t = _seal_commit(p, root, remote)
    if not sha:
        return dict(blind=False, why='החתימה לא נמצאת ב-GitHub', seal=None)
    if t > opened_at:
        return dict(blind=False, why='החתימה מאוחרת מפתיחת קובץ המפעיל', seal=sha)
    return dict(blind=True, why='', seal=sha)


def gate_a_eligible(payload):
    """Only days verified blind count in gate A metrics; a payload without the field (built before the procedure) does not."""
    return payload.get('blind') is True
