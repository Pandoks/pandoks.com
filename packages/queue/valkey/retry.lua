-- KEYS: stream, delayed, dlq
-- ARGV: group, delay_ms, max_attempts, then stream_id, attempt pairs
-- Settles each delivery as failed: dead-letters it once attempt reaches max_attempts, else
-- schedules it to come back after delay_ms as a new entry carrying the attempts spent.
local stream, delayed, dlq = KEYS[1], KEYS[2], KEYS[3]
local group, delay, max_attempts = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3])

local time = server.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local function fields(entry)
  local values = {}
  for index = 1, #entry[2], 2 do values[entry[2][index]] = entry[2][index + 1] end
  return values
end

local settled = 0
for index = 4, #ARGV, 2 do
  local id, attempt = ARGV[index], tonumber(ARGV[index + 1])
  local pending = server.call('XPENDING', stream, group, id, id, 1)[1]
  local values = pending and fields(server.call('XRANGE', stream, id, id)[1])
  -- NOTE: XACK takes no consumer, and a reclaim after the lease raises the delivery count, so
  -- this skips a late retry of an entry that is now another delivery's
  if values and tonumber(values.attempt) + pending[4] == attempt then
    server.call('XACK', stream, group, id)
    if attempt >= max_attempts then
      server.call('XADD', dlq, '*', 'envelope', values.envelope, 'attempt', attempt, 'source', id)
    else
      server.call('ZADD', delayed, now + delay, cjson.encode({ envelope = values.envelope, attempt = attempt }))
    end
    server.call('XDEL', stream, id)
    settled = settled + 1
  end
end
return settled
