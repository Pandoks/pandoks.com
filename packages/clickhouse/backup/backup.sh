#!/bin/sh

set -eu

for v in \
  CLUSTER_NAME \
  NAMESPACE \
  CLICKHOUSE_USER_PASSWORD \
  BACKUP_BUCKET \
  BACKUP_PATH \
  BACKUP_TYPE \
  S3_REGION \
  S3_ENDPOINT \
  S3_KEY \
  S3_KEY_SECRET \
  RETENTION; do
  eval ": \${$v:?Missing $v}"
done

clickhouse_host="clickhouse-${CLUSTER_NAME}.${NAMESPACE}.svc.cluster.local"

clean_backup_path="${BACKUP_PATH#/}"
clean_backup_path="${clean_backup_path%/}"
[ -n "${clean_backup_path}" ] && clean_backup_path="/${clean_backup_path}"
base_url="${S3_ENDPOINT}/${BACKUP_BUCKET}${clean_backup_path}"

rclone_cmd() {
  rclone \
    --s3-provider Other \
    --s3-region "${S3_REGION}" \
    --s3-endpoint "${S3_ENDPOINT}" \
    --s3-access-key-id "${S3_KEY}" \
    --s3-secret-access-key "${S3_KEY_SECRET}" \
    --s3-force-path-style=true \
    "$@"
}

settings=""
if [ "${BACKUP_TYPE}" != "full" ]; then
  echo "Getting backup base for ${BACKUP_TYPE} backup..."
  base_backup_type="full"
  if [ "${BACKUP_TYPE}" = "incr" ]; then
    base_backup_type="diff"
  fi

  base_backup=$(
    { clickhouse-client \
      --host "${clickhouse_host}" \
      --user user \
      --password "${CLICKHOUSE_USER_PASSWORD}" \
      --param_prefix="${base_url}/${base_backup_type}/" \
      --query "SELECT name
                   FROM system.backups
                  WHERE status = 'BACKUP_CREATED'
                    AND startsWith(name, concat('S3(''', {prefix:String}))
                  ORDER BY end_time DESC
                  LIMIT 1" \
      --format=TSVRaw 2> /dev/null || true; } \
      | tr -d '\r\n'
  )

  if [ -n "${base_backup}" ]; then
    # NOTE: we extract the S3 URL and discard the old s3 credentials so you can change change buckets later on
    base_backup_url=$(printf '%s\n' "${base_backup}" | sed -e "s/^S3('\([^']*\)'.*/\1/")
    if [ -n "${base_backup_url}" ]; then
      echo "Found ${base_backup_type} base backup at ${base_backup_url}"
      settings="SETTINGS base_backup = S3('${base_backup_url}', '${S3_KEY}', '${S3_KEY_SECRET}'),
                use_same_password_for_base_backup = 1"
    else
      echo "Unable to parse ${base_backup_type} base backup; running full backup instead"
    fi
  else
    echo "No ${base_backup_type} base backup found; running full backup instead"
  fi
fi

echo "Running ${BACKUP_TYPE} backup..."
timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
clickhouse-client \
  --host "${clickhouse_host}" \
  --user user \
  --password "${CLICKHOUSE_USER_PASSWORD}" \
  --query "BACKUP ALL EXCEPT DATABASES system, INFORMATION_SCHEMA, information_schema
               ON CLUSTER '${CLUSTER_NAME}'
               TO S3('${base_url}/${BACKUP_TYPE}/${timestamp}', '${S3_KEY}', '${S3_KEY_SECRET}')
           ${settings}"
echo "✓ Backup complete"

echo "Cleaning up old backups..."
rel_path="${clean_backup_path#/}"
target_path="${rel_path:+${rel_path}/}${BACKUP_TYPE}/"
if ! entries=$(rclone_cmd lsf --dirs-only --format=p --max-depth 1 ":s3:${BACKUP_BUCKET}/${target_path}" | sed 's#/$##' | sed "/^$/d" | sed "s#^#${target_path}#" | sort); then
  echo "⚠️  Failed to enumerate existing backups; skipping retention cleanup"
  exit 0
fi
echo "Entries found:"
echo "${entries}"

count=$(printf '%s\n' "${entries}" | grep -c '.')
if [ "${count}" -gt "${RETENTION}" ]; then
  backups_to_delete=$(printf '%s\n' "${entries}" | head -n $((count - RETENTION)))
  echo "Deleting backups:"
  echo "${backups_to_delete}"
  printf '%s\n' "${backups_to_delete}" | while read -r victim; do
    rclone_cmd purge ":s3:${BACKUP_BUCKET}/${victim}" > /dev/null 2>&1 \
      || rclone_cmd delete --rmdirs ":s3:${BACKUP_BUCKET}/${victim}"
  done
  echo "✓ Backup cleanup complete"
else
  echo "✓ No backups to cleanup"
fi
