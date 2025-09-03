#!/bin/sh
set -eu

for v in \
  POSTGRES_USER \
  POSTGRES_PASSWORD \
  POSTGRES_DB \
  PGPOOLPASS \
  MASTER_HOST_1 \
  SLAVE_HOST1_1; do
  eval ": \${$v:?Missing $v}"
done

envsubst </tmp/conf_templates/pgcat.toml >/etc/pgcat/pgcat.toml

exec $@
