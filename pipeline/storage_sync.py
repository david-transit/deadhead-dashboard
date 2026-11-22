"""Operator data files (encrypted day / ends / days files) live in the private Supabase Storage bucket 'operator-data',
not in the public repo. Read in the browser with the user's portal session (RLS: viewer of that operator); written only
by the nightly pipeline with the service-role key (never on a personal computer).

  python pipeline/storage_sync.py pull     <slug>             # download what is missing or changed into data/<slug>/
  python pipeline/storage_sync.py push     <slug>             # upload what is new or changed in data/<slug>/
  python pipeline/storage_sync.py seed     <slug> <git-rev>   # one-off: upload the files as they were in git at <rev>
  python pipeline/storage_sync.py manifest <slug>             # data/<slug>/hashes.json: SHA-256 of every day file (public)

Env: SUPABASE_URL (default: the project), SUPABASE_SERVICE_ROLE_KEY. Files are compared by MD5 with Storage's eTag,
so a nightly run moves only what changed (traffic stays far below the Free plan's 5 GB/month)."""
import fnmatch, glob, hashlib, json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

BUCKET = 'operator-data'
URL = os.environ.get('SUPABASE_URL', 'https://xghfcdgettrcdciwwzbl.supabase.co')
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(REPO, 'data')
SYNCED = ('day_*.js', 'ends_*.js', 'days.js')


def _key():
    k = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
    if not k:
        raise SystemExit('SUPABASE_SERVICE_ROLE_KEY is missing')
    return k


def _req(method, path, body=None, headers=None, tries=4):
    h = {'apikey': _key(), 'Authorization': 'Bearer ' + _key(), **(headers or {})}
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(URL + path, data=body, headers=h, method=method), timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code < 500 or i == tries - 1:
                raise SystemExit(f'storage {method} {path}: HTTP {e.code} {e.read()[:300]!r}')
        except OSError as e:
            if i == tries - 1:
                raise SystemExit(f'storage {method} {path}: {e}')
        time.sleep(5 * (i + 1))


def md5(path):
    with open(path, 'rb') as f:
        return hashlib.md5(f.read()).hexdigest()


def sha256(path):
    # line endings normalised (same rule as pva.seal), so a Windows checkout hashes like the runner
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read().replace(b'\r\n', b'\n')).hexdigest()


def remote(slug):
    """{file name: md5} of the operator's objects in the bucket."""
    out, off = {}, 0
    while True:
        rows = json.loads(_req('POST', f'/storage/v1/object/list/{BUCKET}', json.dumps(
            {'prefix': f'{slug}/', 'limit': 1000, 'offset': off, 'sortBy': {'column': 'name', 'order': 'asc'}}).encode(),
            {'Content-Type': 'application/json'}))
        for r in rows:
            if r.get('id'):  # folders have no id
                out[r['name']] = ((r.get('metadata') or {}).get('eTag') or '').strip('"')
        if len(rows) < 1000:
            return out
        off += 1000


def local(slug):
    d = os.path.join(DATA, slug)
    return {os.path.basename(f): f for p in SYNCED for f in glob.glob(os.path.join(d, p))}


def plan_pull(rem, loc_md5):
    """names to download: missing locally or different."""
    return sorted(n for n, e in rem.items() if loc_md5.get(n) != e)


def plan_push(rem, loc_md5):
    """names to upload: missing remotely or different."""
    return sorted(n for n, m in loc_md5.items() if rem.get(n) != m)


def pull(slug):
    d = os.path.join(DATA, slug); os.makedirs(d, exist_ok=True)
    names = plan_pull(remote(slug), {n: md5(f) for n, f in local(slug).items()})
    for n in names:
        data = _req('GET', f'/storage/v1/object/{BUCKET}/{urllib.parse.quote(slug)}/{urllib.parse.quote(n)}')
        with open(os.path.join(d, n), 'wb') as f:
            f.write(data)
    print(f'pull {slug}: {len(names)} file(s)')
    return names


def push(slug):
    loc = local(slug)
    names = plan_push(remote(slug), {n: md5(f) for n, f in loc.items()})
    for n in names:
        with open(loc[n], 'rb') as f:
            _req('POST', f'/storage/v1/object/{BUCKET}/{urllib.parse.quote(slug)}/{urllib.parse.quote(n)}', f.read(),
                 {'Content-Type': 'text/javascript; charset=utf-8', 'x-upsert': 'true', 'Cache-Control': 'no-cache'})
    print(f'push {slug}: {len(names)} file(s)')
    return names


def seed(slug, rev):
    """One-off move: write the files as they were in git at <rev> into data/<slug>/, then push."""
    d = os.path.join(DATA, slug); os.makedirs(d, exist_ok=True)
    out = subprocess.run(['git', '-C', REPO, 'ls-tree', '--name-only', rev, f'data/{slug}/'], check=True, capture_output=True, text=True).stdout.split()
    for p in out:
        n = os.path.basename(p)
        if any(fnmatch.fnmatch(n, x) for x in SYNCED):
            with open(os.path.join(d, n), 'wb') as f:
                f.write(subprocess.run(['git', '-C', REPO, 'show', f'{rev}:{p}'], check=True, capture_output=True).stdout)
    return push(slug)


def manifest(slug, data=DATA):
    """data/<slug>/hashes.json: {day: sha256 of day_<day>.js}. Public (a hash of an encrypted file reveals nothing);
    the blind seal (pva.seal) reads it from GitHub."""
    d = os.path.join(data, slug)
    h = {os.path.basename(f)[4:14]: sha256(f) for f in sorted(glob.glob(os.path.join(d, 'day_*.js')))}
    with open(os.path.join(d, 'hashes.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(h, f, indent=1, sort_keys=True)
        f.write('\n')
    return h


if __name__ == '__main__':
    cmd, slug = sys.argv[1], sys.argv[2]
    if not slug.replace('-', '').isalnum():
        raise SystemExit('bad operator slug')
    {'pull': lambda: pull(slug), 'push': lambda: push(slug), 'seed': lambda: seed(slug, sys.argv[3]),
     'manifest': lambda: print(len(manifest(slug)), 'day hashes')}[cmd]()
