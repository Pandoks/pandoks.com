#!/bin/sh
set -eu

for v in \
  PORT \
  POD_NAME \
  NAMESPACE \
  HEADLESS_SERVICE \
  ANNOUNCE_PORT \
  ANNOUNCE_BUS_PORT; do
  eval ": \${$v:?Missing $v}"
done

envsubst </tmp/conf_templates/valkey.conf >/etc/valkey.conf

exec $@
