-- Copied from transit-studio (Nadav, nadav-rgb), infra/osrm/profiles/bus-relaxed.lua at commit 32aaa6e2bd3c17bc7f35d55bb71c73ff754a36af
-- (branch codex/transit-studio-v1), reused with consent of David and Nadav. Do not edit here: change it upstream and copy again.
-- bus-relaxed (PRD R36): the same bus access rules with no dimension limits. Ways the strict profile blocks stay
-- routable here and are marked (class "dimlimit", ref "dimlimit <tag> way=<id>"), so the app can say which way the
-- strict route avoided and why. Served on 127.0.0.1:5001. See bus_common.lua.
api_version = 4

package.path = '/profiles/?.lua;' .. package.path
local bus = require('bus_common')

return {
  setup = bus.setup,
  process_way = bus.process_way_relaxed,
  process_node = bus.process_node_relaxed,
  process_turn = bus.process_turn,
}
