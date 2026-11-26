#!/bin/sh

set -eu

for v in \
  POSTGRES_DB \
  NAMESPACE \
  POD_NAME \
  POD_IP \
  SUPERUSER_PASSWORD \
  REPLICATION_PASSWORD \
  PATRONI_PASSWORD \
  ADMIN_PASSWORD \
  CLIENT_PASSWORD \
  STANZA; do
  eval ": \${$v:?Missing $v}"
done

if [ -n "${BACKUP_BUCKET+set}" ]; then
  for v in \
    BACKUP_BUCKET \
    BACKUP_PATH \
    S3_ACCESS_KEY \
    S3_SECRET_KEY \
    S3_REGION \
    S3_HOST \
    S3_TLS \
    S3_URI_STYLE \
    ENCRYPTION_KEY \
    BACKUP_HOST_COMMON_NAME; do
    eval ": \${$v:?Missing $v}"
  done
fi

envsubst < /tmp/conf_templates/patroni.yaml > /etc/patroni/patroni.yaml
envsubst < /tmp/conf_templates/pgbackrest.conf > /etc/pgbackrest/pgbackrest.conf

# NOTE: needed here because the volume is mounted after the container is created.
# otherwise you can just do it in the Dockerfile
mkdir -p /var/lib/postgresql/pgdata
chmod 700 /var/lib/postgresql/pgdata

# NOTE: finish an interrupted restore and its full backup before Patroni starts or replicas clone
if [ -d /var/lib/postgresql/restore ]; then
  # NOTE: SIGINT is the image's stop signal
  trap 'if pg_ctl status -D /var/lib/postgresql/pgdata > /dev/null 2>&1; then pg_ctl stop -w -D /var/lib/postgresql/pgdata -m fast; fi; exit 130' INT
  # shellcheck source=packages/postgres/patroni/cluster-init.sh
  . /usr/local/bin/cluster-init.sh
  pg_ctl stop -w -D /var/lib/postgresql/pgdata -m fast
  trap - INT
fi

exec "$@"
