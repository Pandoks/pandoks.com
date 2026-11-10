-- KEYS: stream
-- ARGV: group, then stream_ids
-- Acks and deletes each entry in one step, so a dropped connection can't leave an acked entry
-- that nothing redelivers or deletes.
local stream, group = KEYS[1], ARGV[1]
local ids = { unpack(ARGV, 2) }
server.call('XACK', stream, group, unpack(ids))
return server.call('XDEL', stream, unpack(ids))
