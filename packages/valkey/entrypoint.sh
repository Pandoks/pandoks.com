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

# NOTE: the cluster bus dials only the IPs in nodes.conf, so after every pod restarts at once on new IPs, no node
# reaches another. Meet each failing peer at its hostname's IP, once CLUSTER MYID there shows it's the same node and
# not another cluster's pod on a reused IP, which a MEET would merge into this one
meet_moved_peers() {
  # NOTE: until the server is up and the peers resolve, a failed lookup or command just waits for the next round
  set +e
  export VALKEYCLI_AUTH="${primary_admin_password}"
  while sleep 5; do
    valkey-cli --user admin cluster nodes 2> /dev/null \
      | while read -r meet_moved_peers_id meet_moved_peers_address meet_moved_peers_flags _; do
        case ",${meet_moved_peers_flags}," in
          *,fail,* | *,fail\?,*) ;;
          *) continue ;;
        esac
        # NOTE: the address is ip:port@bus-port,hostname
        meet_moved_peers_hostname=$(echo "${meet_moved_peers_address}" | cut -d, -f2)
        meet_moved_peers_ip=$(getent hosts "${meet_moved_peers_hostname}" | awk '{ print $1; exit }')
        if [ -z "${meet_moved_peers_ip}" ] || [ "${meet_moved_peers_ip}" = "${meet_moved_peers_address%%:*}" ] \
          || [ "$(valkey-cli --user admin -h "${meet_moved_peers_ip}" cluster myid 2> /dev/null)" != "${meet_moved_peers_id}" ]; then
          continue
        fi
        echo "Meeting ${meet_moved_peers_hostname} at its new IP ${meet_moved_peers_ip}"
        valkey-cli --user admin cluster meet "${meet_moved_peers_ip}" 6379 16379
      done
  done
}
meet_moved_peers &

exec "$@"
