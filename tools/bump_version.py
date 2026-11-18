"""Bump the app version (cache busting): python tools/bump_version.py  -> APP_VER in assets/app.js, ?v= in index.html (and plan-actual.html) + version.json.
Run before every commit that changes index.html or its assets."""
import datetime as dt, json, os, re
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
p = os.path.join(HERE, "index.html"); s = open(p, encoding="utf-8").read()
a = os.path.join(HERE, "assets", "app.js"); sa = open(a, encoding="utf-8").read()  # APP_VER lives in the app script
cur = re.search(r'const APP_VER="([^"]+)"', sa).group(1)
day = dt.date.today().isoformat()
n = int(cur.split(".")[-1]) + 1 if cur.startswith(day + ".") else 1
v = f"{day}.{n}"
open(a, "w", encoding="utf-8", newline="\n").write(sa.replace(f'const APP_VER="{cur}"', f'const APP_VER="{v}"'))
s = re.sub(r'((?:src|href)="(?:assets|assets/fonts|mobile)/[^"?]+\.(?:js|css))\?v=[^"]*"', lambda m: f'{m.group(1)}?v={v}"', s)  # local scripts + styles
open(p, "w", encoding="utf-8").write(s)
for extra in ("plan-actual.html",):  # other pages that load the same assets (R53)
    q = os.path.join(HERE, extra)
    if os.path.exists(q):
        t = open(q, encoding="utf-8").read()
        open(q, "w", encoding="utf-8").write(re.sub(r'((?:src|href)="(?:assets|assets/fonts|mobile)/[^"?]+\.(?:js|css))\?v=[^"]*"', lambda m: f'{m.group(1)}?v={v}"', t))
json.dump({"v": v}, open(os.path.join(HERE, "version.json"), "w"))
print(cur, "->", v)
