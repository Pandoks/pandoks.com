-- KEYS: stream, delayed, dlq, reclaim cursor, last sweep, and delayed sequence (one hash tag)
-- ARGV: group, consumer, count, lease_ms, max_attempts
-- Returns {{stream_id, envelope, attempt}, ...}: due delayed retries promoted, expired leases
-- reclaimed (dead-lettered past max_attempts), then new entries. Once a lease, it also removes
-- consumers that hold no entries and haven't received for a lease, like a crashed worker's.
local stream, delayed, dlq, reclaim = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local group, consumer = ARGV[1], ARGV[2]
local count, lease, max_attempts = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])

local time = server.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

pcall(server.call, 'XGROUP', 'CREATE', stream, group, '0', 'MKSTREAM')

for _, member in ipairs(server.call('ZRANGE', delayed, '-inf', now, 'BYSCORE', 'LIMIT', 0, 100)) do
  local retry = cjson.decode(member)
  server.call('XADD', stream, '*', 'envelope', retry.envelope, 'attempt', retry.attempt)
  server.call('ZREM', delayed, member)
end

local function fields(list)
  local values = {}
  for index = 1, #list, 2 do values[list[index]] = list[index + 1] end
  return values
end

local out = {}
-- NOTE: one XAUTOCLAIM scans at most 10 * COUNT pending entries, so resume where the last stopped
local cursor, swept = unpack(server.call('HMGET', reclaim, 'cursor', 'swept'))
local claimed = server.call('XAUTOCLAIM', stream, group, consumer, lease, cursor or '0-0', 'COUNT', count)
server.call('HSET', reclaim, 'cursor', claimed[1])
for _, entry in ipairs(claimed[2]) do
  local values = fields(entry[2])
  local deliveries = server.call('XPENDING', stream, group, entry[1], entry[1], 1)[1][4]
  local attempt = tonumber(values.attempt) + deliveries
  if attempt > max_attempts then
    server.call('XADD', dlq, '*', 'envelope', values.envelope, 'attempt', attempt - 1, 'source', entry[1])
    server.call('XACK', stream, group, entry[1])
    server.call('XDEL', stream, entry[1])
  else
    table.insert(out, { entry[1], values.envelope, attempt })
  end
end

if #out < count then
  local read = server.call('XREADGROUP', 'GROUP', group, consumer, 'COUNT', count - #out, 'STREAMS', stream, '>')
  if read then
    for _, entry in ipairs(read[1][2]) do
      local values = fields(entry[2])
      table.insert(out, { entry[1], values.envelope, tonumber(values.attempt) + 1 })
    end
  end
end
-- NOTE: idle resets on every receive, even an empty one, so this never removes a polling worker
if now - (tonumber(swept) or 0) > lease then
  server.call('HSET', reclaim, 'swept', now)
  for _, row in ipairs(server.call('XINFO', 'CONSUMERS', stream, group)) do
    local info = fields(row)
    if info.pending == 0 and info.idle > lease then
      server.call('XGROUP', 'DELCONSUMER', stream, group, info.name)
    end
  end
end
return out
