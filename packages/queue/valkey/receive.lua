-- KEYS: stream, delayed, dlq (one hash tag, so one slot)
-- ARGV: group, consumer, count, lease_ms, max_attempts
-- Returns {{stream_id, envelope, attempt}, ...}: due delayed retries promoted, expired leases
-- reclaimed (dead-lettered past max_attempts), then new entries.
local stream, delayed, dlq = KEYS[1], KEYS[2], KEYS[3]
local group, consumer = ARGV[1], ARGV[2]
local count, lease, max_attempts = tonumber(ARGV[3]), ARGV[4], tonumber(ARGV[5])

local time = server.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

pcall(server.call, 'XGROUP', 'CREATE', stream, group, '0', 'MKSTREAM')

for _, member in ipairs(server.call('ZRANGE', delayed, '-inf', now, 'BYSCORE', 'LIMIT', 0, 100)) do
  local retry = cjson.decode(member)
  server.call('XADD', stream, '*', 'envelope', retry.envelope, 'attempt', retry.attempt)
  server.call('ZREM', delayed, member)
end

local function fields(entry)
  local values = {}
  for index = 1, #entry[2], 2 do values[entry[2][index]] = entry[2][index + 1] end
  return values
end

local out = {}
local claimed = server.call('XAUTOCLAIM', stream, group, consumer, lease, '0-0', 'COUNT', count)
for _, entry in ipairs(claimed[2]) do
  local values = fields(entry)
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
      local values = fields(entry)
      table.insert(out, { entry[1], values.envelope, tonumber(values.attempt) + 1 })
    end
  end
end
return out
