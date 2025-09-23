#!/bin/sh
set -eu

for v in \
  PORT \
  CLUSTER_NODE_TIMEOUT; do
  eval ": \${$v:?Missing $v}"
done

envsubst </tmp/conf_templates/valkey.conf >/etc/valkey.conf

exec $@
