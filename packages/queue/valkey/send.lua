-- KEYS: stream, delayed
-- ARGV: delay_ms, envelope pairs
-- Adds each envelope as a first attempt, scheduling a delayed one on the server clock receive.lua
-- reads, so a producer's clock skew can't shift it.
local stream, delayed = KEYS[1], KEYS[2]

local time = server.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

for index = 1, #ARGV, 2 do
  local delay, envelope = tonumber(ARGV[index]), ARGV[index + 1]
  if delay == 0 then
    server.call('XADD', stream, '*', 'envelope', envelope, 'attempt', 0)
  else
    server.call('ZADD', delayed, now + delay, cjson.encode({ envelope = envelope, attempt = 0 }))
  end
end
return #ARGV / 2
