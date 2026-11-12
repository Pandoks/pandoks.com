-- KEYS: subscriptions set, then every subscription's stream (all under the topic's hash tag)
-- ARGV: envelopes
-- Fans each envelope out to every subscription queue, failing if the caller's list is stale.
if server.call('SCARD', KEYS[1]) ~= #KEYS - 1 then
  return server.error_reply('STALE subscriptions changed; reread and publish again')
end
for _, envelope in ipairs(ARGV) do
  for index = 2, #KEYS do
    server.call('XADD', KEYS[index], '*', 'envelope', envelope, 'attempt', 0)
  end
end
return #KEYS - 1
