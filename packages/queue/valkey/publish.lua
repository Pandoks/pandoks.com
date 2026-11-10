-- KEYS: subscriptions set, then every subscription's stream (all under the topic's hash tag)
-- ARGV: envelope
-- Fans one envelope out to every subscription queue, failing if the caller's list is stale.
if server.call('SCARD', KEYS[1]) ~= #KEYS - 1 then
  return server.error_reply('STALE subscriptions changed; reread and publish again')
end
for index = 2, #KEYS do
  server.call('XADD', KEYS[index], '*', 'envelope', ARGV[1], 'attempt', 0)
end
return #KEYS - 1
