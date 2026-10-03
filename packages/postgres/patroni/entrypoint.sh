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
  BACKUP_BUCKET \
  BACKUP_PATH \
  S3_ACCESS_KEY \
  S3_SECRET_KEY \
  S3_REGION \
  S3_HOST \
  S3_TLS \
  S3_URI_STYLE \
  ENCRYPTION_KEY \
  BACKUP_HOST_COMMON_NAME \
  STANZA; do
  # backup.enabled=false omits the backup and S3 env vars.
  case "$v" in BACKUP_* | S3_* | ENCRYPTION_KEY) [ -n "${BACKUP_BUCKET+set}" ] || continue ;; esac
  eval ": \${$v:?Missing $v}"
done

envsubst < /tmp/conf_templates/patroni.yaml > /etc/patroni/patroni.yaml
envsubst < /tmp/conf_templates/pgbackrest.conf > /etc/pgbackrest/pgbackrest.conf

# NOTE: needed here because the volume is mounted after the container is created.
# otherwise you can just do it in the Dockerfile
mkdir -p /var/lib/postgresql/pgdata
chmod 700 /var/lib/postgresql/pgdata

exec "$@"
