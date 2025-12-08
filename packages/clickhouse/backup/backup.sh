#!/bin/sh
set -euo pipefail

HOST="clickhouse-$CLUSTER_NAME.$NAMESPACE.svc.cluster.local"
SETTINGS="SETTINGS password = '${BACKUP_PASSWORD}'"
SCHEMA=$([ "${S3_TLS}" = "n" ] && echo http || echo https)

CLEAN_BACKUP_PATH="${BACKUP_PATH#/}"
CLEAN_BACKUP_PATH="${CLEAN_BACKUP_PATH%/}"
[ -n "${CLEAN_BACKUP_PATH}" ] && CLEAN_BACKUP_PATH="/${CLEAN_BACKUP_PATH}"
BASE_URL="${SCHEMA}://${S3_ENDPOINT}/${BACKUP_BUCKET}${CLEAN_BACKUP_PATH}"

if [ "${BACKUP_TYPE}" != "full" ]; then
  echo "Getting backup base for ${BACKUP_TYPE} backup..."
  BASE_BACKUP_TYPE="full"
  if [ "${BACKUP_TYPE}" = "incr" ]; then
    BASE_BACKUP_TYPE="diff"
  fi

  BASE_BACKUP=$(
    { clickhouse-client \
        --host "${HOST}" \
        --user user \
        --password "${CLICKHOUSE_USER_PASSWORD}" \
        --param_prefix="${BASE_URL}/${BASE_BACKUP_TYPE}/" \
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
      echo "Found ${BASE_BACKUP_TYPE} base backup at ${BASE_BACKUP_URL}"
      SETTINGS="${SETTINGS},
                base_backup = S3('${BASE_BACKUP_URL}', '${S3_KEY}', '${S3_KEY_SECRET}'), 
                use_same_password_for_base_backup = 1"
    else
      echo "Unable to parse ${BASE_BACKUP_TYPE} base backup; running full backup instead"
    fi
  else
    echo "No ${BASE_BACKUP_TYPE} base backup found; running full backup instead"
  fi
fi

echo "Running ${BACKUP_TYPE} backup..."
TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
clickhouse-client \
  --host "${HOST}" \
  --user user \
  --password "${CLICKHOUSE_USER_PASSWORD}" \
  --query "BACKUP ALL
               ON CLUSTER '$CLUSTER_NAME'
               TO S3('$BASE_URL/${BACKUP_TYPE}/${TIMESTAMP}', '$S3_KEY', '$S3_KEY_SECRET')
           ${SETTINGS}"
echo "✓ Backup complete"

echo "Cleaning up old backups..."
REL_PATH="${CLEAN_BACKUP_PATH#/}"
PREFIX="${REL_PATH:+${REL_PATH}/}${BACKUP_TYPE}/"
ENTRIES=$(
  { aws s3api list-objects-v2 \
      --endpoint-url "${SCHEMA}://${S3_ENDPOINT}" \
      --bucket "${BACKUP_BUCKET}" \
      --prefix "${PREFIX}" \
      --delimiter '/' \
      --query 'CommonPrefixes[].Prefix' \
      --output text } |
    tr '\t' '\n' | sed 's#/$##' | sort
)
echo "Entries found:"
echo "${ENTRIES}"
