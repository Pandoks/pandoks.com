-- KEYS: subscriptions set, then every subscription's stream (all under the topic's hash tag)
-- ARGV: envelopes
-- Fans each envelope out to every subscription queue, failing if the caller's list is stale.
local prefix = string.sub(KEYS[1], 1, -#'subscriptions' - 1)
local current = server.call('SCARD', KEYS[1]) == #KEYS - 1
for index = 2, #KEYS do
  local subscription = string.sub(KEYS[index], #prefix + 1, -#':stream' - 1)
  current = current and server.call('SISMEMBER', KEYS[1], subscription) == 1
end
if not current then
  return server.error_reply('STALE subscriptions changed; reread and publish again')
end
for _, envelope in ipairs(ARGV) do
  for index = 2, #KEYS do
    server.call('XADD', KEYS[index], '*', 'envelope', envelope, 'attempt', 0)
  end
end
return #KEYS - 1
