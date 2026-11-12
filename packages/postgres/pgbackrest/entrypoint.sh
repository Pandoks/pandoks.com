#!/bin/sh

set -eu

# NOTE: Patroni's maximum_lag_on_failover: a replica close enough to take over is current enough
max_replay_lag_bytes=16777216

write_pg_host() {
  cat << EOF
pg$1-path=/var/lib/postgresql/pgdata
pg$1-user=postgres
pg$1-host=$2.patroni-${STANZA}.${NAMESPACE}.svc.cluster.local
pg$1-host-type=tls
pg$1-host-cert-file=/etc/pgbackrest/certs/server.crt
pg$1-host-key-file=/etc/pgbackrest/certs/server.key
pg$1-host-ca-file=/etc/pgbackrest/certs/ca.crt
EOF
}

write_backup_hosts() {
  write_backup_hosts_cluster="$(curl --fail --silent --show-error --max-time 10 "http://patroni-${STANZA}:8008/cluster")"
  echo "${write_backup_hosts_cluster}" \
    | jq -r '.members[] | "Member \(.name): \(.role), \(.state), replay lag \(.replay_lag // "n/a")"'

  write_backup_hosts_primary="$(echo "${write_backup_hosts_cluster}" \
    | jq -r '.members[] | select(.role == "leader") | .name')"
  : "${write_backup_hosts_primary:?No primary in ${STANZA}}"
  write_backup_hosts_replica="$(echo "${write_backup_hosts_cluster}" \
    | jq -r --argjson max_replay_lag "${max_replay_lag_bytes}" '
      [.members[] | select(.role != "leader" and .state == "streaming"
        and (.replay_lag | type) == "number" and .replay_lag <= $max_replay_lag)]
      | min_by(.replay_lag) | .name // empty')"

  {
    echo "[${STANZA}]"
    write_pg_host 1 "${write_backup_hosts_primary}"
    if [ -n "${write_backup_hosts_replica}" ]; then
      echo "backup-standby=y"
      write_pg_host 2 "${write_backup_hosts_replica}"
    fi
  } >> /etc/pgbackrest/pgbackrest.conf

  if [ -n "${write_backup_hosts_replica}" ]; then
    echo "Backing up through replica ${write_backup_hosts_replica}, primary ${write_backup_hosts_primary}"
  else
    echo "Backing up from primary ${write_backup_hosts_primary}:" \
      "no replica is streaming within ${max_replay_lag_bytes} bytes of replay lag"
  fi
}

for v in \
  PGPASSWORD \
  STANZA \
  BACKUP_BUCKET \
  BACKUP_PATH \
  S3_ACCESS_KEY \
  S3_SECRET_KEY \
  S3_REGION \
  S3_HOST \
  S3_TLS \
  S3_URI_STYLE \
  ENCRYPTION_KEY; do
  eval ": \${$v:?Missing $v}"
done

envsubst < /tmp/conf_templates/pgbackrest.conf > /etc/pgbackrest/pgbackrest.conf

if echo "$@" | grep -q "server"; then
  echo "Running as server..."
else
  echo "Running as client..."
  for v in \
    FULL_RETENTION \
    DIFF_RETENTION \
    CLIENT_COMMON_NAME \
    NAMESPACE; do
    eval ": \${$v:?Missing $v}"
  done
  write_backup_hosts
fi

exec "$@"
