-- KEYS: stream
-- ARGV: group, consumer
-- Removes a closing queue's consumer unless it still owns pending entries, which deleting it
-- would make unclaimable.
local stream, group, consumer = KEYS[1], ARGV[1], ARGV[2]
pcall(server.call, 'XGROUP', 'CREATE', stream, group, '0', 'MKSTREAM')
if #server.call('XPENDING', stream, group, '-', '+', 1, consumer) > 0 then
  return 0
end
return server.call('XGROUP', 'DELCONSUMER', stream, group, consumer)
