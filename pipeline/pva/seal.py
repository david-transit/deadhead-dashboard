"""Blind seal (OP-DATA-7, ADR-0010 interim procedure, David 22.11.2026).

Before an operator file of a service day is opened, the SHA-256 of every file of that day's blind reconstruction
(the nightly pipeline's day file, data/<operator>/day_<D>.js) is written to <operator>/<D>.json on the 'seals' branch and pushed:
the commit on GitHub is the external timestamp. Only hashes, never data.
After the files are read, verify() hashes the reconstruction again and compares: no seal, a different hash,
a seal that is not on GitHub or is later than the opening, or a day read before the procedure -> "not blind",
and the day does not count in gate A metrics (gate_a_eligible)."""
import datetime as dt, glob, hashlib, json, os, shutil, subprocess, tempfile

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


SEAL_BRANCH = 'seals'  # seals live on their own branch: main is protected (CI must pass), this branch takes direct pushes


def seal_rel(day, op):
    return f'{op}/{day}.json'


def locked(day, root=ROOT):
    a, b = policy(root)['locked']
    return a <= str(day) <= b


def _git(root, *args):
    return subprocess.run(['git', '-C', root, *args], check=True, capture_output=True, text=True).stdout.strip()


def _fetch(root):
    try:
        _git(root, 'fetch', '-q', 'origin', f'+refs/heads/{SEAL_BRANCH}:refs/remotes/origin/{SEAL_BRANCH}')
        return True
    except subprocess.CalledProcessError:
        return False  # the branch does not exist yet


def _remote_seal(root, rel):
    """(record, sha, commit time) of the seal on GitHub (origin/seals), or (None, None, None)."""
    try:
        rec = json.loads(_git(root, 'show', f'origin/{SEAL_BRANCH}:{rel}'))
    except (subprocess.CalledProcessError, ValueError):
        return None, None, None
    out = _git(root, 'log', '--diff-filter=A', '--format=%H %cI', f'origin/{SEAL_BRANCH}', '--', rel)
    if not out:
        return None, None, None
    sha, t = out.splitlines()[-1].split(' ', 1)
    return rec, sha, dt.datetime.fromisoformat(t)


def _clear(wt):
    for x in os.listdir(wt):
        if x == '.git':
            continue
        f = os.path.join(wt, x)
        shutil.rmtree(f, ignore_errors=True) if os.path.isdir(f) else os.remove(f)


def seal_days(days, op, root=ROOT, now=None):
    """Write the seal of every day that has none yet on GitHub, commit it to the seals branch and push.
    Refuses the engine's locked period. Returns the seal paths (in the seals branch) sealed now.
    Raises SealError (nothing is opened) if anything fails."""
    days = [str(d) for d in days]
    bad = [d for d in days if locked(d, root)]
    if bad:
        raise SealError(f'locked period (engine test): operator files are not opened for {", ".join(bad)}')
    now = now or dt.datetime.now(dt.timezone.utc)
    has_branch = _fetch(root)
    recs = {}
    for d in days:
        rel = seal_rel(d, op)
        if has_branch and _remote_seal(root, rel)[0] is not None:
            continue  # the first seal stands; verify() compares against it
        recs[rel] = dict(day=d, operator=op, sealed_at=now.isoformat(timespec='seconds'),
                         files=[dict(path=os.path.relpath(f, root).replace(os.sep, '/'), sha256=sha256(f)) for f in blind_files(d, op, root)])
    if not recs:
        return []
    wt = tempfile.mkdtemp(prefix='seal-')
    tmp_branch = f'_{SEAL_BRANCH}_new'
    try:
        if has_branch:
            _git(root, 'worktree', 'add', '-q', '-f', '--detach', wt, f'origin/{SEAL_BRANCH}')
        else:
            _git(root, 'worktree', 'add', '-q', '-f', '--detach', wt, 'HEAD')
            _git(wt, 'checkout', '-q', '--orphan', tmp_branch)
            _git(wt, 'rm', '-rqf', '--cached', '.')
            _clear(wt)
        for rel, rec in recs.items():
            f = os.path.join(wt, rel)
            os.makedirs(os.path.dirname(f), exist_ok=True)
            with open(f, 'w', encoding='utf-8', newline='\n') as fh:  # closed (flushed) before git add
                json.dump(rec, fh, ensure_ascii=False, indent=1)
        _git(wt, 'add', *recs)
        _git(wt, 'commit', '-q', '-m', f'seal: {op} {" ".join(days)} (blind reconstruction hashes, OP-DATA-7)')
        _git(wt, 'push', '-q', 'origin', f'HEAD:refs/heads/{SEAL_BRANCH}')
    except subprocess.CalledProcessError as e:
        raise SealError(f'seal was not committed/pushed, operator files stay closed: {e.stderr or e}')
    finally:
        subprocess.run(['git', '-C', root, 'worktree', 'remove', '--force', wt], capture_output=True)
        subprocess.run(['git', '-C', root, 'branch', '-D', tmp_branch], capture_output=True)
        shutil.rmtree(wt, ignore_errors=True)
    return list(recs)


def verify(day, op, opened_at, root=ROOT):
    """Check after opening. Returns dict(blind, why, seal) for the day's payload."""
    day = str(day)
    if day <= policy(root)['not_blind_through']:
        return dict(blind=False, why='נקרא לפני 22.11 (לפני נוהל החתימה)', seal=None)
    _fetch(root)
    rec, sha, t = _remote_seal(root, seal_rel(day, op))
    if rec is None:
        return dict(blind=False, why='אין חתימה לשחזור העיוור ב-GitHub', seal=None)
    try:
        now = {os.path.relpath(f, root).replace(os.sep, '/'): sha256(f) for f in blind_files(day, op, root)}
    except SealError:
        now = {}
    if now != {f['path']: f['sha256'] for f in rec['files']}:
        return dict(blind=False, why='השחזור העיוור שונה מהחתימה', seal=None)
    if t > opened_at:
        return dict(blind=False, why='החתימה מאוחרת מפתיחת קובץ המפעיל', seal=sha)
    return dict(blind=True, why='', seal=sha)


def gate_a_eligible(payload):
    """Only days verified blind count in gate A metrics; a payload without the field (built before the procedure) does not."""
    return payload.get('blind') is True
