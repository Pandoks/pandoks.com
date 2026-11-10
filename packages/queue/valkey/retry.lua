-- KEYS: stream, delayed, dlq
-- ARGV: group, delay_ms, max_attempts, then stream_id, attempt pairs
-- Settles each delivery as failed: dead-letters it once attempt reaches max_attempts, else
-- schedules it to come back after delay_ms as a new entry carrying the attempts spent.
local stream, delayed, dlq = KEYS[1], KEYS[2], KEYS[3]
local group, delay, max_attempts = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3])

local time = server.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local settled = 0
for index = 4, #ARGV, 2 do
  local id, attempt = ARGV[index], tonumber(ARGV[index + 1])
  -- NOTE: an entry this consumer no longer owns was reclaimed by another; leave it to that one
  if server.call('XACK', stream, group, id) == 1 then
    local entry = server.call('XRANGE', stream, id, id)[1]
    local envelope
    for field = 1, #entry[2], 2 do
      if entry[2][field] == 'envelope' then envelope = entry[2][field + 1] end
    end
    if attempt >= max_attempts then
      server.call('XADD', dlq, '*', 'envelope', envelope, 'attempt', attempt, 'source', id)
    else
      server.call('ZADD', delayed, now + delay, cjson.encode({ envelope = envelope, attempt = attempt }))
    end
    server.call('XDEL', stream, id)
    settled = settled + 1
  end
end
return settled
