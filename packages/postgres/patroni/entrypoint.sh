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

envsubst < /tmp/conf_templates/patroni.yaml > /etc/patroni/patroni.yaml

# Disposable clusters run without backups, so the chart omits the backup bucket and credentials.
if [ "${BACKUP_ENABLED:-true}" = true ]; then
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

  envsubst < /tmp/conf_templates/pgbackrest.conf > /etc/pgbackrest/pgbackrest.conf
fi

# NOTE: needed here because the volume is mounted after the container is created.
# otherwise you can just do it in the Dockerfile
mkdir -p /var/lib/postgresql/pgdata
chmod 700 /var/lib/postgresql/pgdata

exec "$@"
