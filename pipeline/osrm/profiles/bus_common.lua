-- Copied from transit-studio (Nadav, nadav-rgb), infra/osrm/profiles/bus_common.lua at commit 32aaa6e2bd3c17bc7f35d55bb71c73ff754a36af
-- (branch codex/transit-studio-v1), reused with consent of David and Nadav. Do not edit here: change it upstream and copy again.
-- Shared code of the two bus profiles (PRD R36). Both profiles start from the car.lua shipped in the pinned OSRM image
-- (ghcr.io/project-osrm/osrm-backend:v26.10.0-debian, /opt/car.lua), so the upstream file is pinned by the image tag and
-- is never copied or downloaded. Every change against car.lua is marked `bus:` below.
--
-- The profiles are mounted read-only at /profiles; car.lua and its lib/ live in /opt.
package.path = '/profiles/?.lua;/opt/?.lua;' .. package.path

local car = dofile('/opt/car.lua')
local dimensions = require('bus_dimensions')

local M = {}

M.dimensions = dimensions

-- Marker written into the relaxed profile's `ref` of a way that the strict profile blocks. The app reads it from the
-- route steps (src/lib/routing/restrictions.ts). Keep the two formats in sync.
M.MARKER_PREFIX = 'dimlimit'
M.CLASS = 'dimlimit'

local function trim(value)
  return (value:gsub('^%s+', ''):gsub('%s+$', ''))
end

-- Metres from an OSM length value: "3.6", "3.6 m", "3,6", "12'6\"". Non-numeric values ("default", "none") are nil.
function M.parse_meters(raw)
  if not raw then return nil end
  local s = trim(raw:lower():gsub(',', '.'))
  local metres = s:match('^([%d%.]+)%s*m?$')
  if metres then return tonumber(metres) end
  local feet, inches = s:match("^(%d+)%s*'%s*(%d*)%s*\"?$")
  if feet then return tonumber(feet) * 0.3048 + (tonumber(inches) or 0) * 0.0254 end
  return nil
end

-- Tonnes from an OSM weight value: "19", "19 t", "12000 kg", "40000 lbs". Non-numeric values are nil.
function M.parse_tonnes(raw)
  if not raw then return nil end
  local s = trim(raw:lower():gsub(',', '.'))
  local tonnes = s:match('^([%d%.]+)%s*t?$')
  if tonnes then return tonumber(tonnes) end
  local kg = s:match('^([%d%.]+)%s*kg$')
  if kg then return tonumber(kg) / 1000 end
  local lbs = s:match('^([%d%.]+)%s*lbs?$')
  if lbs then return tonumber(lbs) * 0.000453592 end
  return nil
end

-- Dimension checks, in order. `inclusive`: a physical road width equal to the bus width is already too narrow.
-- For each key the directional variant (":forward" / ":backward") wins over the plain one, and the first present key
-- wins (":physical" over the signed value). This is the only dimension rule in both profiles: car.lua's own checks are
-- switched off, so everything the strict profile blocks is something the relaxed profile marks and the app explains.
local CHECKS = {
  { keys = { 'maxheight:physical', 'maxheight' }, parse = M.parse_meters, limit = 'height_m' },
  { keys = { 'maxwidth:physical', 'maxwidth' }, parse = M.parse_meters, limit = 'width_m' },
  { keys = { 'width', 'est_width' }, parse = M.parse_meters, limit = 'width_m', inclusive = true },
  { keys = { 'maxlength' }, parse = M.parse_meters, limit = 'length_m' },
  { keys = { 'maxweight', 'maxweightrating' }, parse = M.parse_tonnes, limit = 'weight_t' },
}

local function below(check, value)
  local limit = dimensions[check.limit]
  if check.inclusive then return value <= limit end
  return value < limit
end

-- The first tag that keeps the bus off this way in `direction` ('forward' or 'backward'), as "key=value", or nil.
-- `get(key)` reads a tag (a way's or a node's).
function M.blocking_tag_of(get, direction)
  for _, check in ipairs(CHECKS) do
    for _, key in ipairs(check.keys) do
      local tag = key .. ':' .. direction
      local raw = get(tag)
      if not raw then tag = key; raw = get(key) end
      if raw then
        local value = check.parse(raw)
        if value and below(check, value) then return tag .. '=' .. trim(raw) end
        break
      end
    end
  end
  local narrow = get('narrow')
  if narrow and narrow ~= 'no' then return 'narrow=' .. trim(narrow) end
  return nil
end

function M.blocking_tag(way, direction)
  return M.blocking_tag_of(function(key) return way:get_value_by_key(key) end, direction or 'forward')
end

local function accessible(result)
  return result.forward_mode ~= mode.inaccessible or result.backward_mode ~= mode.inaccessible
end

-- car.lua's setup plus the bus access rules from docs/research/2026-11-02-routing-and-travel-time.md.
function M.setup()
  local profile = car.setup()
  -- bus: buses may use psv/bus lanes and roads.
  profile.access_tag_whitelist['psv'] = true
  profile.access_tag_whitelist['bus'] = true
  profile.access_tag_blacklist['psv'] = nil
  profile.access_tag_blacklist['bus'] = nil
  profile.access_tag_blacklist['minibus'] = nil
  -- bus: the bus-specific access tags win over the general ones.
  profile.access_tags_hierarchy = Sequence { 'bus', 'psv', 'motor_vehicle', 'vehicle', 'access' }
  profile.restrictions = Sequence { 'bus', 'psv', 'motor_vehicle', 'vehicle' }
  -- bus: bus-only roads are routable.
  profile.speeds.highway.busway = 50
  -- bus: a bus trap (sump buster) stops cars and lets buses through.
  profile.barrier_whitelist['bus_trap'] = true
  profile.barrier_whitelist['sump_buster'] = true
  -- bus: car.lua's own dimension checks (ways and height_restrictor nodes) are off in both profiles; CHECKS is the only
  -- dimension rule, so no limit blocks the bus without an explanation.
  profile.vehicle_height = 0
  profile.vehicle_width = 0
  profile.vehicle_length = 0
  profile.vehicle_weight = 0
  -- bus: one more class for ways above the bus limits (OSRM allows 8 classes; car.lua uses 5).
  table.insert(profile.classes, M.CLASS)
  return profile
end

-- bus-strict: a direction of a way below any bus dimension is not routable.
function M.process_way_strict(profile, way, result, relations)
  car.process_way(profile, way, result, relations)
  if not accessible(result) then return end
  if M.blocking_tag(way, 'forward') then result.forward_mode = mode.inaccessible end
  if M.blocking_tag(way, 'backward') then result.backward_mode = mode.inaccessible end
end

-- bus-relaxed: the same way stays routable but carries the class (per direction) and a ref marker with the blocking
-- tag and the way id.
function M.process_way_relaxed(profile, way, result, relations)
  car.process_way(profile, way, result, relations)
  if not accessible(result) then return end
  local forward = M.blocking_tag(way, 'forward')
  local backward = M.blocking_tag(way, 'backward')
  if forward then result.forward_classes[M.CLASS] = true end
  if backward then result.backward_classes[M.CLASS] = true end
  local tag = forward or backward
  if tag then result.ref = M.MARKER_PREFIX .. ' ' .. tag .. ' way=' .. tostring(way:id()) end
end

-- A node below the bus height (a height restrictor, a low gate, ...), as "key=value", or nil. Strict blocks it; relaxed
-- lets it through and lists it, so the app can explain a detour around it like one around a way.
function M.node_blocking_tag(node)
  for _, key in ipairs({ 'maxheight:physical', 'maxheight' }) do
    local raw = node:get_value_by_key(key)
    if raw then
      local value = M.parse_meters(raw)
      if value and value < dimensions.height_m then return key .. '=' .. trim(raw) end
      return nil
    end
  end
  return nil
end

-- Where the relaxed build lists the low barriers: next to the graph, read by the app (OSRM_LOW_BARRIERS_CSV).
M.BARRIERS_FILE = os.getenv('BUS_BARRIERS_FILE') or '/data/low-barriers.csv'

-- One line per low barrier: node id, lon, lat, tag. osrm-extract calls this from several threads; each line is one
-- short write to a file opened for appending, so lines do not interleave.
local function list_barrier(node, tag)
  local location = node:location()
  local file = io.open(M.BARRIERS_FILE, 'a')
  if not file then return end
  file:setvbuf('no')
  file:write(string.format('%d,%.7f,%.7f,%s\n', node:id(), location:lon(), location:lat(), tag))
  file:close()
end

-- bus-strict: a barrier node below the bus height blocks the bus.
function M.process_node_strict(profile, node, result, relations)
  car.process_node(profile, node, result, relations)
  if M.node_blocking_tag(node) then result.barrier = true end
end

-- bus-relaxed: the same node stays passable and is listed in BARRIERS_FILE.
function M.process_node_relaxed(profile, node, result, relations)
  car.process_node(profile, node, result, relations)
  local tag = M.node_blocking_tag(node)
  if tag then list_barrier(node, tag) end
end

M.process_node = car.process_node
M.process_turn = car.process_turn

return M
