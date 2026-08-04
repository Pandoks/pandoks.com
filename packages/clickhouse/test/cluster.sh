#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../../.."
readonly SCRIPT_DIR
readonly REPO_ROOT

. "${REPO_ROOT}/scripts/lib/font.sh"
. "${REPO_ROOT}/scripts/lib/log.sh"
. "${REPO_ROOT}/scripts/lib/test.sh"

NAMESPACE=test-clickhouse
NAME=tch
RELEASE=tch
SERVER_STS=clickhouse-tch-shard-0
KEEPER_STS=clickhouse-keeper-tch
CREDS_SECRET=clickhouse-tch-creds
CHART="${SCRIPT_DIR}/../chart"
readonly NAMESPACE NAME RELEASE SERVER_STS KEEPER_STS CREDS_SECRET CHART

test_cleanup() {
  helm uninstall "${RELEASE}" -n "${NAMESPACE}" > /dev/null 2>&1 || true
  test_delete_namespace "${NAMESPACE}"
}

ch_sql() {
  ch_sql_pod="$1"
  shift
  kubectl exec -n "${NAMESPACE}" "${ch_sql_pod}" -c clickhouse -- \
    sh -c "clickhouse-client --user admin --password \"\${CLICKHOUSE_ADMIN_PASSWORD}\" -q \"$*\""
}

ch_sts_ready() {
  [ "$(kubectl get sts "$1" -n "${NAMESPACE}" -o jsonpath='{.status.replicas} {.status.readyReplicas}')" = "$2 $2" ]
}

ch_no_readonly_replicas() {
  [ "$(ch_sql "$1" "SELECT count() FROM system.replicas WHERE is_readonly")" = "0" ]
}

ch_row_visible() {
  [ "$(ch_sql "$1" "SELECT id FROM default.cluster_smoke")" = "7" ]
}

ch_backup_created() {
  [ "$(ch_sql "${SERVER_STS}-0" "SELECT count() FROM clusterAllReplicas('${NAME}', system.backups) WHERE status='BACKUP_CREATED'")" -ge 1 ]
}

ch_backup_object_in_s3() {
  docker exec s3 awslocal s3 ls --recursive s3://database/kubernetes/test/clickhouse/ | grep -q .
}

ch_keeper_reachable() {
  ch_sql "${SERVER_STS}-0" "SELECT count() FROM system.zookeeper WHERE path='/'" > /dev/null 2>&1
}

test_suite clickhouse

echo "Cleaning up any stale ${NAMESPACE} resources..."
test_cleanup

test_case "install: keeper quorum, both replicas serving, cluster registered"
kubectl create namespace "${NAMESPACE}"
kubectl create secret generic "${CREDS_SECRET}" -n "${NAMESPACE}" \
  --from-literal=ADMIN_PASSWORD=testpassword \
  --from-literal=CLIENT_PASSWORD=testpassword
kubectl create secret generic backup-bucket-creds -n "${NAMESPACE}" \
  --from-literal=S3_ACCESS_KEY=test \
  --from-literal=S3_SECRET_KEY=testsecret
helm install "${RELEASE}" "${CHART}" -n "${NAMESPACE}" \
  --set name="${NAME}" \
  --set namespace="${NAMESPACE}" \
  --set credentials.secret="${CREDS_SECRET}" \
  --set clickhouse.image=local-registry:5000/clickhouse:latest \
  --set keeper.image=local-registry:5000/clickhouse-keeper:latest \
  --set backup.image=local-registry:5000/clickhouse-backup:latest \
  --set backup.bucket=database \
  --set backup.path=kubernetes/test/clickhouse \
  --set s3.endpoint=http://172.30.0.254:4566 \
  --timeout 10m > /dev/null
test_wait_for 300 "3 keeper pods ready" ch_sts_ready "${KEEPER_STS}" 3
test_wait_for 600 "2 server pods ready" ch_sts_ready "${SERVER_STS}" 2
test_wait_for 120 "keeper quorum reachable from server" ch_keeper_reachable
test_assert_eq "cluster '${NAME}' has 2 replicas in system.clusters" 2 \
  "$(ch_sql "${SERVER_STS}-0" "SELECT count() FROM system.clusters WHERE cluster='${NAME}'")"

test_case "replication: row inserted on replica 0 appears on replica 1"
ch_sql "${SERVER_STS}-0" "CREATE TABLE default.cluster_smoke ON CLUSTER '${NAME}' (id UInt32) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/cluster_smoke', '{replica}') ORDER BY id" > /dev/null
ch_sql "${SERVER_STS}-0" "INSERT INTO default.cluster_smoke VALUES (7)"
test_wait_for 60 "row visible on replica 1" ch_row_visible "${SERVER_STS}-1"

test_case "pod recovery: deleted replica rejoins, not readonly, data intact"
kubectl delete pod "${SERVER_STS}-1" -n "${NAMESPACE}" --wait=false > /dev/null
test_wait_for 300 "replica 1 recreated and ready" ch_sts_ready "${SERVER_STS}" 2
test_wait_for 120 "no readonly replicas" ch_no_readonly_replicas "${SERVER_STS}-1"
test_assert "replicated row still present" ch_row_visible "${SERVER_STS}-1"

test_case "backup smoke: manual full backup lands in s3"
kubectl create job --from="cronjob/clickhouse-${NAME}-backup-full" "${NAME}-backup-smoke" -n "${NAMESPACE}" > /dev/null
test_wait_for 600 "backup job succeeded" sh -c \
  "kubectl get job ${NAME}-backup-smoke -n ${NAMESPACE} -o jsonpath='{.status.succeeded}' | grep -q 1"
test_assert "system.backups reports BACKUP_CREATED" ch_backup_created
test_assert "backup objects visible in localstack s3" ch_backup_object_in_s3
