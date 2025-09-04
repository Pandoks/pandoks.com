#!/bin/sh
set -eu

for v in \
  POSTGRES_DB \
  NAMESPACE \
  POD_NAME \
  POD_IP \
  PGUSER \
  PGPASSWORD \
  PGREPPASS \
  PATRONI_PASSWORD; do
  eval ": \${$v:?Missing $v}"
done

envsubst </tmp/conf_templates/patroni.yaml >/etc/patroni/patroni.yaml

exec $@
