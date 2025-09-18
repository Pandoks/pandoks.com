#!/bin/sh
set -eu

for v in \
  STANZA \
  BACKUP_BUCKET \
  BACKUP_PATH \
  S3_KEY \
  S3_KEY_SECRET \
  S3_REGION \
  S3_ENDPOINT \
  S3_TLS \
  S3_URI_STYLE \
  ENCRYPTION_KEY; do
  eval ": \${$v:?Missing $v}"
done

envsubst </tmp/conf_templates/pgbackrest.conf >/etc/pgbackrest.conf

exec "$@"
