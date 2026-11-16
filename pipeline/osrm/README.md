# Our own OSRM with a bus profile (nightly)

Empty-leg road distances can be routed with a **bus** profile instead of the public car server: the car profile cannot
use bus-only roads and inflates the km.

**Status: OFF (car) until David approves the bus-vs-car review.** Switch on: repository variable
`DEADHEAD_ROUTING=bus` (Settings → Secrets and variables → Actions → Variables); the next nightly routes new legs with
bus-strict and re-routes cached car routes. Then run the checker with `--bus` (G5). Switch off: delete the variable.
Review: `.github/workflows/bus-compare.yml` (manual, or a push to branch bus-osrm) routes every unique leg of the live day
files with bus-strict, bus-relaxed and the public car server, uploads the result encrypted (artifact `bus-compare`);
`compare.js` does the routing.

- `profiles/` — the bus profiles of **transit-studio (Nadav)**, copied unchanged from `infra/osrm/profiles/` at commit
  `32aaa6e2bd3c17bc7f35d55bb71c73ff754a36af` (branch `codex/transit-studio-v1`), reused with the consent of David and
  Nadav. Each file carries a header with the source. Do not edit them here: change them upstream and copy again.
  `bus-strict` = bus/psv access rules (bus lanes and bus-only roads allowed, bus traps passable) and no way below the bus
  dimensions in `bus_dimensions.lua`; it wraps `/opt/car.lua` of the pinned image. `bus-relaxed` is built only by
  bus-compare (it marks the ways the strict profile blocks).
- Image: `ghcr.io/project-osrm/osrm-backend:v26.10.0-debian`, the same pinned tag as transit-studio's
  `infra/osrm/compose.yaml`.
- Map data: Geofabrik `israel-and-palestine-latest.osm.pbf` (© OpenStreetMap contributors, ODbL).
- `serve.sh` — run by `.github/workflows/nightly.yml`: restores the MLD graph from `actions/cache` (key = OSRM version +
  ISO week + hash of `profiles/*.lua`, so it is rebuilt weekly and whenever a profile changes), otherwise downloads the
  extract and builds it (osrm-extract / partition / customize), then starts `osrm-routed` on `127.0.0.1:5000` for the
  job only. Nothing depends on Nadav's machine.
- `pipeline/route.js` routes against `OSRM_BASE` (the local server). If it is down, or has no route for a leg, that leg
  is routed by the public car server and marked `fb: 1` — the dashboard shows "חושב ברכב פרטי (גיבוי)". Cached routes
  (`pipeline/cache/osrm_cache.json`, meta `p` = profile, `fb` = fallback) of another profile or from a fallback are
  routed again on the next run.
- Without `OSRM_BASE` (a local run on a PC without Docker) the pipeline uses the public car server as before (`p: "car"`).

The browser (night legs, reinforcement dialog, anchors, savings) still routes with the public car server — see the
hand-over note for the proposal to serve those from precomputed bus routes.
