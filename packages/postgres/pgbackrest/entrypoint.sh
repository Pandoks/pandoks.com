#!/bin/sh

set -eu

for v in \
  PGPASSWORD \
  STANZA \
  BACKUP_BUCKET \
  BACKUP_PATH \
  S3_KEY \
  S3_KEY_SECRET \
  S3_REGION \
  S3_HOST \
  S3_TLS \
  S3_URI_STYLE \
  ENCRYPTION_KEY; do
  eval ": \${$v:?Missing $v}"
done

if echo "$@" | grep -q "server"; then
  echo "Running as server..."
else
  echo "Running as client..."
  for v in \
    FULL_RETENTION \
    DIFF_RETENTION \
    CLIENT_COMMON_NAME \
    MASTER_HOST \
    SLAVE_HOST; do
    eval ": \${$v:?Missing $v}"
  done
fi

envsubst < /tmp/conf_templates/pgbackrest.conf > /etc/pgbackrest.conf

exec "$@"
