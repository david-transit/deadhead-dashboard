"""Bump the app version (cache busting): python tools/bump_version.py  -> APP_VER in index.html + version.json.
Run before every commit that changes index.html or its assets."""
import datetime as dt, json, os, re
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
p = os.path.join(HERE, "index.html"); s = open(p, encoding="utf-8").read()
cur = re.search(r'const APP_VER="([^"]+)"', s).group(1)
day = dt.date.today().isoformat()
n = int(cur.split(".")[-1]) + 1 if cur.startswith(day + ".") else 1
v = f"{day}.{n}"
s = s.replace(f'const APP_VER="{cur}"', f'const APP_VER="{v}"')
s = re.sub(r'(src="assets/[^"?]+\.js)\?v=[^"]*"', lambda m: f'{m.group(1)}?v={v}"', s)  # local scripts
open(p, "w", encoding="utf-8").write(s)
json.dump({"v": v}, open(os.path.join(HERE, "version.json"), "w"))
print(cur, "->", v)
