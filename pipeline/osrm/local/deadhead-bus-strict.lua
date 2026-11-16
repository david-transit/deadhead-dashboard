-- deadhead bus-strict: transit-studio's bus-strict profile (../profiles, copied unchanged) plus the approved exceptions in
-- bus_exceptions.csv (mounted at /local): a way or node listed there is not blocked by the dimension tags its row names
-- (e.g. a city weight sign meant for trucks on a street that buses already use). Everything else is bus_common.lua as is.
-- Built by pipeline/osrm/serve.sh; the answers are still labelled "bus-strict".
api_version = 4

package.path = '/profiles/?.lua;/opt/?.lua;' .. package.path
local bus = require('bus_common')
local car = dofile('/opt/car.lua')

local DIMS = { maxweight = true, maxweightrating = true, maxheight = true, maxwidth = true, width = true, est_width = true,
               maxlength = true, narrow = true }
local EX = {}  -- EX['way:123'] = { maxweight = true }
local file = io.open('/local/bus_exceptions.csv', 'r')
if file then
  for line in file:lines() do
    local kind, id, ignore = line:match('^%s*(%a+)%s*,%s*(%d+)%s*,%s*([^,]+),')
    if kind and (kind == 'way' or kind == 'node') then
      local set = {}
      for key in ignore:gmatch('[^;%s"]+') do
        if DIMS[key] then set[key] = true end
        if key == 'maxweight' then set.maxweightrating = true end
        if key == 'width' then set.est_width = true end
      end
      EX[kind .. ':' .. id] = set
    end
  end
  file:close()
end

local function base(key) return (key:gsub(':.*$', '')) end

local function process_way(profile, way, result, relations)
  local ex = EX['way:' .. tostring(way:id())]
  if not ex then return bus.process_way_strict(profile, way, result, relations) end
  car.process_way(profile, way, result, relations)
  if result.forward_mode == mode.inaccessible and result.backward_mode == mode.inaccessible then return end
  local get = function(key) if ex[base(key)] then return nil end return way:get_value_by_key(key) end
  if bus.blocking_tag_of(get, 'forward') then result.forward_mode = mode.inaccessible end
  if bus.blocking_tag_of(get, 'backward') then result.backward_mode = mode.inaccessible end
end

local function process_node(profile, node, result, relations)
  local ex = EX['node:' .. tostring(node:id())]
  if ex and ex.maxheight then return car.process_node(profile, node, result, relations) end
  return bus.process_node_strict(profile, node, result, relations)
end

return {
  setup = bus.setup,
  process_way = process_way,
  process_node = process_node,
  process_turn = bus.process_turn,
}
