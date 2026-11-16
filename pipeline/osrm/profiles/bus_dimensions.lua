-- Copied from transit-studio (Nadav, nadav-rgb), infra/osrm/profiles/bus_dimensions.lua at commit 32aaa6e2bd3c17bc7f35d55bb71c73ff754a36af
-- (branch codex/transit-studio-v1), reused with consent of David and Nadav. Do not edit here: change it upstream and copy again.
-- Bus dimensions for the bus-strict profile (PRD R36, approved by David on 2026-11-03, docs/QUESTIONS-FOR-DAVID.md #11).
-- This file is the single place to change them (R34: no value is fixed in code). A change takes effect only after
-- rebuilding the strict graph (`pnpm osrm:build`), because OSRM bakes the profile into the graph.
return {
  height_m = 4.0,
  width_m = 2.55,
  length_m = 12.5,
  weight_t = 19.5,
}
