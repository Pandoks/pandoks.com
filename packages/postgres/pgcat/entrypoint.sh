#!/bin/sh
set -eu

for v in \
  POSTGRES_USER \
  POSTGRES_PASSWORD \
  POSTGRES_DB \
  PGCATPASS \
  MASTER_HOST \
  SLAVE_HOST; do
  eval ": \${$v:?Missing $v}"
done

envsubst </tmp/conf_templates/pgcat.toml >/etc/pgcat/pgcat.toml

exec $@
