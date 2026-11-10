#!/bin/sh

set -eu

for v in \
  POD_NAME \
  NAMESPACE \
  HEADLESS_SERVICE \
  ADMIN_PASSWORD \
  CLIENT_PASSWORD; do
  eval ": \${$v:?Missing $v}"
done

case "${ADMIN_PASSWORD}" in
  *'
'*)
    echo "ADMIN_PASSWORD must not contain a newline" >&2
    exit 1
    ;;
esac

# NOTE: valkey.conf, unlike users.acl, unquotes values, so escape \ and " for the quoted primaryauth
ESCAPED_ADMIN_PASSWORD=$(printf '%s' "${ADMIN_PASSWORD}" | sed 's/[\\"]/\\&/g') \
  envsubst < /tmp/conf_templates/valkey.conf > /etc/valkey/valkey.conf
envsubst < /tmp/conf_templates/users.acl > /etc/valkey/users.acl

if [ -n "${PERSISTENCE:-}" ]; then
  echo "dir /data" >> /etc/valkey/valkey.conf

  IFS=','
  for mode in ${PERSISTENCE}; do
    case $mode in
      aof)
        cat >> /etc/valkey/valkey.conf << EOF

appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec
EOF
        ;;
      rdb)
        cat >> /etc/valkey/valkey.conf << EOF

dbfilename "dump.rdb"
save 900 1
save 300 10
save 60 10000
EOF
        ;;
    esac
  done
  unset IFS
else
  # NOTE: rdb-del-sync-files deletes the dump.rdb a replica's full sync leaves on the PVC, which a restart would load as stale data
  cat >> /etc/valkey/valkey.conf << EOF

# disabled default rdb settings
save ""
rdb-del-sync-files yes
EOF
fi

exec "$@"
