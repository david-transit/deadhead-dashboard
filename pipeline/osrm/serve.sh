#!/usr/bin/env bash
# Build (when missing) and start our own OSRM with the bus-strict profile on 127.0.0.1:5000 (nightly, Linux + Docker).
#   pipeline/osrm/serve.sh <graph dir>
# The graph dir is restored from actions/cache when it holds a graph of this week's extract and these profiles;
# otherwise the Geofabrik extract is downloaded and the MLD graph built (osrm-extract, osrm-partition, osrm-customize).
# Prints "osrm=ok" to $GITHUB_OUTPUT when the server answers; on any failure it exits 0 with "osrm=down" so the
# pipeline falls back to the public car server (legs marked "חושב ברכב פרטי (גיבוי)").
set -u
DIR=$1
IMAGE=ghcr.io/project-osrm/osrm-backend:v26.10.0-debian   # same pinned image as transit-studio infra/osrm/compose.yaml
PBF_URL=https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf
PROFILES=$(cd "$(dirname "$0")/profiles" && pwd)
OUT=${GITHUB_OUTPUT:-/dev/null}
fail() { echo "::warning::OSRM bus: $* (falling back to the public car server)"; echo "osrm=down" >> "$OUT"; exit 0; }
t0=$(date +%s)
mkdir -p "$DIR"
run() { docker run --rm --user "$(id -u):$(id -g)" -v "$DIR:/data" -v "$PROFILES:/profiles:ro" "$IMAGE" "$@"; }

if [ -f "$DIR/israel.osrm.mldgr" ] && [ -f "$DIR/israel.osrm.cell_metrics" ]; then
  echo "graph from cache: $(cat "$DIR/extract.txt" 2>/dev/null)"
else
  rm -rf "${DIR:?}"/*
  curl -fsSL --retry 3 -o "$DIR/israel.osm.pbf" "$PBF_URL" || fail "extract download failed"
  { echo "source=$PBF_URL"; curl -fsSI "$PBF_URL" | grep -i '^last-modified' | tr -d '\r'; echo "built=$(date -u +%FT%TZ)"; echo "image=$IMAGE";
    echo "profile=bus-strict ($(sha256sum "$PROFILES"/*.lua | sha256sum | cut -c1-12))"; } > "$DIR/extract.txt"
  cat "$DIR/extract.txt"
  run osrm-extract -p /profiles/bus-strict.lua /data/israel.osm.pbf || fail "osrm-extract failed"
  run osrm-partition /data/israel.osrm || fail "osrm-partition failed"
  run osrm-customize /data/israel.osrm || fail "osrm-customize failed"
  rm -f "$DIR/israel.osm.pbf"
  echo "graph built in $(( $(date +%s) - t0 )) s, $(du -sh "$DIR" | cut -f1)"
fi

docker rm -f osrm >/dev/null 2>&1
docker run -d --name osrm -p 127.0.0.1:5000:5000 -v "$DIR:/data:ro" "$IMAGE" osrm-routed --algorithm mld /data/israel.osrm >/dev/null \
  || fail "osrm-routed did not start"
for i in $(seq 1 60); do
  if curl -fs "http://127.0.0.1:5000/nearest/v1/driving/35.2137,31.7683" >/dev/null; then
    # smoke: Beit Horon -> Agan HaAyalot (Givat Ze'ev) uses the bus-only road "האיילות" with the bus profile
    curl -fs "http://127.0.0.1:5000/route/v1/driving/35.1265,31.87828;35.14067,31.86533?overview=false&steps=true" | python3 -c '
import json,sys; r=json.load(sys.stdin)["routes"][0]
names=[s["name"] for l in r["legs"] for s in l["steps"] if s["name"]]
print("smoke Beit Horon -> Agan HaAyalot: %.2f km %.1f min via %s" % (r["distance"]/1000, r["duration"]/60, " > ".join(dict.fromkeys(names))))' || true
    echo "osrm=ok" >> "$OUT"; echo "OSRM bus-strict up after $(( $(date +%s) - t0 )) s"; exit 0
  fi
  sleep 2
done
docker logs osrm 2>&1 | tail -20
fail "osrm-routed did not answer"
