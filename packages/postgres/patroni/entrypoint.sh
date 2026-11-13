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

# NOTE: Patroni would end an interrupted restore's replay on a repo error, and its replicas would
# clone the pre-restore backup until cluster-init.sh's full backup succeeds
if [ -f /var/lib/postgresql/pgdata/restore.pending ]; then
  # NOTE: SIGINT is the image's stop signal
  trap 'pg_ctl stop -w -D /var/lib/postgresql/pgdata -m fast; exit 130' INT
  pg_ctl start -W -D /var/lib/postgresql/pgdata -o "-c hot_standby=off"
  echo "Waiting for the interrupted restore's recovery to finish..."
  until pg_isready -q; do
    sleep 10
    pg_ctl status -D /var/lib/postgresql/pgdata > /dev/null
  done
  until pgbackrest --stanza="${STANZA}" backup --type=full; do
    echo "Failed to create the restored cluster's full backup. Retrying in 10s..."
    sleep 10
  done
  rm /var/lib/postgresql/pgdata/restore.pending
  echo "✓ Full backup created successfully. Replicas can now bootstrap."
  pg_ctl stop -w -D /var/lib/postgresql/pgdata -m fast
fi

exec "$@"
