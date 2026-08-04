#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../../.."
readonly SCRIPT_DIR
readonly REPO_ROOT

. "${REPO_ROOT}/scripts/lib/font.sh"
. "${REPO_ROOT}/scripts/lib/log.sh"
. "${REPO_ROOT}/scripts/lib/test.sh"

NAMESPACE=test-postgres
DB=tpg
RELEASE=tpg
APP=patroni-tpg-shard-0
CLUSTER=tpg-shard-0
CREDS_SECRET=postgres-tpg-creds
CHART="${SCRIPT_DIR}/../chart"
readonly NAMESPACE DB RELEASE APP CLUSTER CREDS_SECRET CHART

test_cleanup() {
  helm uninstall "${RELEASE}" -n "${NAMESPACE}" > /dev/null 2>&1 || true
  test_delete_namespace "${NAMESPACE}"
}

pg_pods() {
  kubectl get pods -n "${NAMESPACE}" -l "app=${APP}" -o name | sed 's|pod/||'
}

pg_leader() {
  kubectl get pods -n "${NAMESPACE}" -l "cluster-name=${CLUSTER},role=primary" -o name 2> /dev/null \
    | head -n 1 | sed 's|pod/||'
}

pg_sql() {
  kubectl exec -n "${NAMESPACE}" "$1" -c patroni -- psql -U postgres -d postgres -tAc "$2"
}

pg_upgrade() {
  helm upgrade "${RELEASE}" "${CHART}" -n "${NAMESPACE}" --reuse-values --timeout 10m "$@" > /dev/null
}

pg_fingerprint() {
  test_pod_fingerprint "${NAMESPACE}" "app=${APP}"
}

pg_sts_ready() {
  [ "$(kubectl get sts "${APP}" -n "${NAMESPACE}" -o jsonpath='{.status.replicas} {.status.readyReplicas} {.status.updatedReplicas}')" = "$1 $1 $1" ]
}

pg_all_show() {
  for pg_all_show_pod in $(pg_pods); do
    [ "$(pg_sql "${pg_all_show_pod}" "show $1")" = "$2" ] || return 1
  done
}

pg_all_pending_restart() {
  for pg_all_pending_restart_pod in $(pg_pods); do
    [ "$(kubectl exec -n "${NAMESPACE}" "${pg_all_pending_restart_pod}" -c patroni -- \
      python3 -c 'import json,urllib.request;print(json.load(urllib.request.urlopen("http://localhost:8008/patroni")).get("pending_restart",False))')" = "True" ] || return 1
  done
}

pg_streaming_count_is() {
  [ "$(pg_sql "$(pg_leader)" "select count(*) from pg_stat_replication where state='streaming'")" = "$1" ]
}

pg_member_count_is() {
  [ "$(kubectl exec -n "${NAMESPACE}" "$(pg_leader)" -c patroni -- \
    sh -c 'patronictl -c /etc/patroni/patroni.yaml list -f json | python3 -c "import json,sys;print(len(json.load(sys.stdin)))"')" = "$1" ]
}

pg_checksum() {
  kubectl get sts "${APP}" -n "${NAMESPACE}" -o jsonpath='{.spec.template.metadata.annotations.checksum/config}'
}

pg_leader_exists() {
  [ -n "$(pg_leader)" ]
}

pg_new_leader_elected() {
  pg_new_leader_elected_now=$(pg_leader)
  [ -n "${pg_new_leader_elected_now}" ] && [ "${pg_new_leader_elected_now}" != "$1" ]
}

pg_all_pods_replaced() {
  pg_all_pods_replaced_current=$(kubectl get pods -n "${NAMESPACE}" -l "app=${APP}" \
    -o jsonpath='{range .items[*]}{.metadata.uid}{"\n"}{end}')
  for pg_all_pods_replaced_uid in $1; do
    printf '%s\n' "${pg_all_pods_replaced_current}" | grep -q "${pg_all_pods_replaced_uid}" && return 1
  done
  pg_sts_ready 3
}

test_suite postgres

echo "Cleaning up any stale ${NAMESPACE} resources..."
test_cleanup

test_case "install: 3/3 ready, 1 leader + 2 streaming replicas, values live"
kubectl create namespace "${NAMESPACE}"
kubectl create secret generic "${CREDS_SECRET}" -n "${NAMESPACE}" \
  --from-literal=SUPERUSER_PASSWORD=testpassword \
  --from-literal=ADMIN_PASSWORD=testpassword \
  --from-literal=CLIENT_PASSWORD=testpassword \
  --from-literal=REPLICATION_PASSWORD=testpassword \
  --from-literal=PATRONI_PASSWORD=testpassword
kubectl create secret generic backup-bucket-creds -n "${NAMESPACE}" \
  --from-literal=S3_ACCESS_KEY=test \
  --from-literal=S3_SECRET_KEY=testsecret
helm install "${RELEASE}" "${CHART}" -n "${NAMESPACE}" \
  --set db="${DB}" \
  --set namespace="${NAMESPACE}" \
  --set credentials.secret="${CREDS_SECRET}" \
  --set patroni.image=local-registry:5000/patroni:latest \
  --set backup.image=local-registry:5000/pgbackrest:latest \
  --set backup.bucket=database \
  --set backup.path=kubernetes/test/postgres \
  --set backup.encryptionKey=1f2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff00 \
  --set s3.host=172.30.0.254:4566 \
  --timeout 15m > /dev/null
test_wait_for 600 "all 3 patroni pods ready" pg_sts_ready 3
test_wait_for 120 "leader elected" pg_leader_exists
test_wait_for 120 "2 replicas streaming" pg_streaming_count_is 2
test_wait_for 60 "dcs values live (max_connections=100)" pg_all_show max_connections 100
test_assert "shared_buffers=128MB on all pods" pg_all_show shared_buffers 128MB
test_assert "work_mem=4MB on all pods" pg_all_show work_mem 4MB

test_case "reload-class dcs change applies live with zero pod churn"
fingerprint_before=$(pg_fingerprint)
checksum_before=$(pg_checksum)
pg_upgrade --set patroni.parameters.dcs.work_mem=8MB
test_wait_for 60 "work_mem=8MB live on all pods" pg_all_show work_mem 8MB
test_assert_eq "pod fingerprints unchanged (zero churn)" "${fingerprint_before}" "$(pg_fingerprint)"
test_assert_eq "checksum/config annotation unchanged" "${checksum_before}" "$(pg_checksum)"

test_case "postmaster-class dcs change parks as pending_restart until patronictl restart"
fingerprint_before=$(pg_fingerprint)
pg_upgrade --set patroni.parameters.dcs.shared_buffers=256MB
test_wait_for 90 "pending_restart flagged on all pods" pg_all_pending_restart
test_assert "shared_buffers still 128MB before restart" pg_all_show shared_buffers 128MB
test_assert_eq "no pod churn from upgrade" "${fingerprint_before}" "$(pg_fingerprint)"
kubectl exec -n "${NAMESPACE}" "$(pg_leader)" -c patroni -- \
  patronictl -c /etc/patroni/patroni.yaml restart "${CLUSTER}" --force > /dev/null
test_wait_for 120 "shared_buffers=256MB after in-place restart" pg_all_show shared_buffers 256MB
test_assert_eq "pods restarted in place (fingerprints unchanged)" "${fingerprint_before}" "$(pg_fingerprint)"

test_case "dcs-restricted parameter is helm-manageable"
pg_upgrade --set patroni.parameters.dcs.max_connections=150
test_wait_for 90 "pending_restart flagged on all pods" pg_all_pending_restart
kubectl exec -n "${NAMESPACE}" "$(pg_leader)" -c patroni -- \
  patronictl -c /etc/patroni/patroni.yaml restart "${CLUSTER}" --force > /dev/null
test_wait_for 120 "max_connections=150 after restart" pg_all_show max_connections 150

test_case "local-map change rolls all pods"
checksum_before=$(pg_checksum)
old_uids=$(kubectl get pods -n "${NAMESPACE}" -l "app=${APP}" \
  -o jsonpath='{range .items[*]}{.metadata.uid}{"\n"}{end}')
pg_upgrade --set patroni.parameters.local.log_min_duration_statement=1000
test_assert_ne "checksum/config annotation changed" "${checksum_before}" "$(pg_checksum)"
test_wait_for 600 "all pods recreated and ready" pg_all_pods_replaced "${old_uids}"
test_wait_for 120 "2 replicas streaming after roll" pg_streaming_count_is 2
test_wait_for 60 "log_min_duration_statement=1s on all pods" pg_all_show log_min_duration_statement 1s

test_case "failover: no data loss, old leader rejoins"
leader=$(pg_leader)
pg_sql "${leader}" "create table if not exists failover_marker(id int primary key)" > /dev/null
pg_sql "${leader}" "insert into failover_marker values (42) on conflict do nothing" > /dev/null
kubectl delete pod "${leader}" -n "${NAMESPACE}" --wait=false > /dev/null
test_wait_for 60 "new leader elected" pg_new_leader_elected "${leader}"
test_assert_eq "marker row survived failover" 42 "$(pg_sql "$(pg_leader)" 'select id from failover_marker')"
test_wait_for 300 "old leader rejoined (3/3 ready)" pg_sts_ready 3
test_wait_for 120 "2 replicas streaming again" pg_streaming_count_is 2

test_case "scale up to 4 members, back down to 3"
pg_upgrade --set patroni.replicasPerShard=4
test_wait_for 600 "4th member ready" pg_sts_ready 4
test_wait_for 120 "3 replicas streaming" pg_streaming_count_is 3
test_assert "4 members in patronictl list" pg_member_count_is 4
pg_upgrade --set patroni.replicasPerShard=3
test_wait_for 300 "back to 3/3 ready" pg_sts_ready 3
test_wait_for 120 "removed member gone from patronictl list" pg_member_count_is 3
test_wait_for 120 "2 replicas streaming" pg_streaming_count_is 2
