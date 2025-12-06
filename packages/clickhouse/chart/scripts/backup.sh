#!/bin/sh
set -euo pipefail

BASE_BACKUP_CLAUSE=""
if [ "${BACKUP_TYPE}" != "full" ]; then
  BASE_BACKUP_TYPE="full"
  if [ "${BACKUP_TYPE}" = "incr" ]; then
    BASE_BACKUP_TYPE="diff"
  fi

  BASE_BACKUP=$(
    { clickhouse-client \
        --host "clickhouse-$CLUSTER_NAME.$NAMESPACE.svc.cluster.local" \
        --user user \
        --password "${CLICKHOUSE_USER_PASSWORD}" \
        --param_prefix="${S3_PREFIX}/${BASE_BACKUP_TYPE}/" \
        --query "SELECT name
                 FROM system.backups
                 WHERE status = 'BACKUP_CREATED'
                   AND startsWith(name, concat('S3(''', {prefix:String}))
                 ORDER BY end_time DESC
                 LIMIT 1" \
        --format=TSVRaw 2>/dev/null || true; } |
      tr -d '\r\n'
  )

  if [ -n "${BASE_BACKUP}" ]; then
    # NOTE: we extract the S3 URL and discard the old s3 credentials so you can change change buckets later on
    BASE_BACKUP_URL=$(printf '%s\n' "${BASE_BACKUP}" | sed -e "s/^S3('\([^']*\)'.*/\1/")
    if [ -n "${BASE_BACKUP_URL}" ]; then
      BASE_BACKUP_CLAUSE="SETTINGS base_backup = S3('${BASE_BACKUP_URL}', '${S3_KEY}', '${S3_KEY_SECRET}')"
    else
      log "Unable to parse ${BASE_BACKUP_TYPE} base backup; running full backup instead"
    fi
  else
    log "No ${BASE_BACKUP_TYPE} base backup found; running full backup instead"
  fi
fi
