-- KEYS: stream
-- ARGV: group, then stream_ids
-- Acks and deletes each entry in one step, so a dropped connection can't leave an acked entry
-- that nothing redelivers or deletes.
local stream, group = KEYS[1], ARGV[1]
local deleted = 0
-- NOTE: unpack fails past Lua's ~8000-value stack limit, so ack in chunks
for first = 2, #ARGV, 1000 do
  local last = math.min(first + 999, #ARGV)
  server.call('XACK', stream, group, unpack(ARGV, first, last))
  deleted = deleted + server.call('XDEL', stream, unpack(ARGV, first, last))
end
return deleted
