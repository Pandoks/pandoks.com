#!/bin/sh

set -eu

for v in \
  POD_NAME \
  NAMESPACE \
  HEADLESS_SERVICE \
  ADMIN_PASSWORD \
  CLIENT_PASSWORD \
  METRICS_PASSWORD; do
  eval ": \${$v:?Missing $v}"
done

case "${ADMIN_PASSWORD}" in
  *'
'*)
    echo "ADMIN_PASSWORD must not contain a newline" >&2
    exit 1
    ;;
esac

primary_admin_password="${ADMIN_PASSWORD}"
acl_admin_passwords="${ADMIN_PASSWORD}"
# NOTE: until apply-config rotates a changed admin password, the other nodes accept only the last-applied one
if [ -f /etc/valkey-admin/applied ]; then
  applied_admin_password=$(cat /etc/valkey-admin/applied)
  if [ "${applied_admin_password}" != "${ADMIN_PASSWORD}" ]; then
    primary_admin_password="${applied_admin_password}"
    acl_admin_passwords="${ADMIN_PASSWORD} >${applied_admin_password}"
  fi
fi

# NOTE: listing the variables keeps envsubst off other $ in parameters, like notify-keyspace-events $xKE.
# valkey.conf, unlike users.acl, unquotes values, so escape \ and " for the quoted primaryauth
ESCAPED_ADMIN_PASSWORD=$(printf '%s' "${primary_admin_password}" | sed 's/[\\"]/\\&/g') \
  envsubst "$(printf '$%s ' POD_NAME HEADLESS_SERVICE NAMESPACE ESCAPED_ADMIN_PASSWORD)" \
  < /tmp/conf_templates/valkey.conf > /etc/valkey/valkey.conf
# NOTE: users.acl's >${ADMIN_PASSWORD} then also takes the last-applied password
ADMIN_PASSWORD="${acl_admin_passwords}" \
  envsubst "$(printf '$%s ' ADMIN_PASSWORD CLIENT_PASSWORD METRICS_PASSWORD)" \
  < /tmp/conf_templates/users.acl > /etc/valkey/users.acl

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
