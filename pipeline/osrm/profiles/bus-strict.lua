-- Copied from transit-studio (Nadav, nadav-rgb), infra/osrm/profiles/bus-strict.lua at commit 32aaa6e2bd3c17bc7f35d55bb71c73ff754a36af
-- (branch codex/transit-studio-v1), reused with consent of David and Nadav. Do not edit here: change it upstream and copy again.
-- bus-strict (PRD R36, default profile): bus access rules, and no way below the bus dimensions in bus_dimensions.lua.
-- Served on 127.0.0.1:5000. See bus_common.lua for every change against the image's car.lua.
api_version = 4

package.path = '/profiles/?.lua;' .. package.path
local bus = require('bus_common')

return {
  setup = bus.setup,
  process_way = bus.process_way_strict,
  process_node = bus.process_node_strict,
  process_turn = bus.process_turn,
}
