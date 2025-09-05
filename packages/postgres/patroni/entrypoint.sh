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
envsubst </tmp/conf_templates/pgbackrest.conf >/etc/pgbackrest.conf

# NOTE: needed here because the volume is mounted after the container is created.
# otherwise you can just do it in the Dockerfile
mkdir -p /var/lib/postgresql/pgdata
chmod 700 /var/lib/postgresql/pgdata

exec $@
