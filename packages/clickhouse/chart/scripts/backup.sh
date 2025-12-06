#!/bin/sh
set -euo pipefail

if [ "${BACKUP_TYPE}" != "full" ]; then
  BASE_BACKUP_TYPE="full"
  if [ "${BACKUP_TYPE}" = "incr" ]; then
    BASE_BACKUP_TYPE="diff"
  fi

  BASE_BACKUP=$(clickhouse-client \
    --host clickhouse-$CLUSTER_NAME.$NAMESPACE.svc.cluster.local \
    --user user \
    --password "${CLICKHOUSE_USER_PASSWORD}" \
    --param_prefix="${S3_PREFIX}/${BASE_BACKUP_TYPE}/" \ 
    --query "SELECT name 
               FROM system.backups 
              WHERE status = 'BACKUP_CREATED' 
                AND startsWith(name, concat('S3(''', {prefix:String})) 
           ORDER BY end_time DESC LIMIT 1" \
    --format=TSVRaw 2>/dev/null || true)
  BASE_BACKUP=$(printf '%s' "${BASE_BACKUP}" | tr -d '\r\n')
fi
