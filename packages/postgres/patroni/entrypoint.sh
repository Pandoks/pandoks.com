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

# NOTE: Patroni would end an interrupted restore on a repo error; restores append, so the last one wins
if [ -f /var/lib/postgresql/pgdata/recovery.signal ] \
  && grep "^restore_command = " /var/lib/postgresql/pgdata/postgresql.auto.conf | tail -n 1 \
  | grep -q "^restore_command = 'until pgbackrest"; then
  # NOTE: SIGINT is the image's stop signal
  trap 'pg_ctl stop -w -D /var/lib/postgresql/pgdata -m fast; exit 130' INT
  pg_ctl start -W -D /var/lib/postgresql/pgdata -o "-c hot_standby=off"
  echo "Waiting for the interrupted restore's recovery to finish..."
  until pg_isready -q; do
    sleep 10
    pg_ctl status -D /var/lib/postgresql/pgdata > /dev/null
  done
  if pgbackrest --stanza="${STANZA}" backup --type=full; then
    echo "✓ Full backup created successfully. Replicas can now bootstrap."
  else
    echo "Warning: Failed to create full backup. Replicas may restore the previous backup's settings."
  fi
  pg_ctl stop -w -D /var/lib/postgresql/pgdata -m fast
fi

exec "$@"
