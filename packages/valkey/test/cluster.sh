#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../../.."
readonly SCRIPT_DIR
readonly REPO_ROOT

. "${REPO_ROOT}/scripts/lib/font.sh"
. "${REPO_ROOT}/scripts/lib/log.sh"
. "${REPO_ROOT}/scripts/lib/test.sh"

NAMESPACE=test-valkey
NAME=tvk
RELEASE=tvk
APP=valkey-tvk
CREDS_SECRET=valkey-tvk-creds
CHART="${SCRIPT_DIR}/../chart"
readonly NAMESPACE NAME RELEASE APP CREDS_SECRET CHART

test_cleanup() {
  helm uninstall "${RELEASE}" -n "${NAMESPACE}" > /dev/null 2>&1 || true
  test_delete_namespace "${NAMESPACE}"
}

vk_pods() {
  kubectl get pods -n "${NAMESPACE}" -l "app=${APP}" -o name | sed 's|pod/||'
}

vk_cli() {
  vk_cli_pod="$1"
  shift
  kubectl exec -n "${NAMESPACE}" "${vk_cli_pod}" -c valkey -- \
    sh -c "valkey-cli --user admin -a \"\${ADMIN_PASSWORD}\" --no-auth-warning $*"
}

vk_upgrade() {
  helm upgrade "${RELEASE}" "${CHART}" -n "${NAMESPACE}" --reuse-values --timeout 15m "$@" > /dev/null
}

vk_sts_ready() {
  [ "$(kubectl get sts "${APP}" -n "${NAMESPACE}" -o jsonpath='{.status.replicas} {.status.readyReplicas}')" = "$1 $1" ]
}

vk_cluster_info_has() {
  vk_cli "$1" cluster info | grep -q "$2"
}

vk_all_state_ok() {
  for vk_all_state_ok_pod in $(vk_pods); do
    vk_cluster_info_has "${vk_all_state_ok_pod}" cluster_state:ok || return 1
  done
}

vk_role_is() {
  vk_cli "$1" info replication | tr -d '\r' | grep -q "^role:$2$"
}

vk_find_master() {
  for vk_find_master_pod in $(vk_pods); do
    if vk_role_is "${vk_find_master_pod}" master; then
      printf '%s\n' "${vk_find_master_pod}"
      return 0
    fi
  done
  return 1
}

vk_replica_of() {
  vk_replica_of_ip=$(kubectl get pod "$1" -n "${NAMESPACE}" -o jsonpath='{.status.podIP}')
  for vk_replica_of_pod in $(vk_pods); do
    if vk_cli "${vk_replica_of_pod}" info replication | tr -d '\r' | grep -q "^master_host:${vk_replica_of_ip}$"; then
      printf '%s\n' "${vk_replica_of_pod}"
      return 0
    fi
  done
  return 1
}

vk_role_count() {
  vk_role_count_n=0
  for vk_role_count_pod in $(vk_pods); do
    if vk_role_is "${vk_role_count_pod}" "$1"; then
      vk_role_count_n=$((vk_role_count_n + 1))
    fi
  done
  printf '%s\n' "${vk_role_count_n}"
}

vk_roles_balanced() {
  [ "$(vk_role_count master)" -eq 2 ] && [ "$(vk_role_count slave)" -eq 2 ]
}

vk_healthy() {
  vk_sts_ready "$1" || return 1
  vk_all_state_ok || return 1
  vk_cluster_info_has "${APP}-0" "cluster_size:$2" || return 1
  vk_cluster_info_has "${APP}-0" "cluster_known_nodes:$1" || return 1
  vk_cluster_info_has "${APP}-0" cluster_slots_assigned:16384 || return 1
  vk_cluster_info_has "${APP}-0" cluster_slots_ok:16384 || return 1
  ! vk_cli "${APP}-0" cluster nodes | grep -q fail
}

test_suite valkey

echo "Cleaning up any stale ${NAMESPACE} resources..."
test_cleanup

test_case "install: init hook succeeds, cluster_state:ok with 2 masters + 2 replicas"
kubectl create namespace "${NAMESPACE}"
kubectl create secret generic "${CREDS_SECRET}" -n "${NAMESPACE}" \
  --from-literal=ADMIN_PASSWORD=testpassword \
  --from-literal=CLIENT_PASSWORD=testpassword
helm install "${RELEASE}" "${CHART}" -n "${NAMESPACE}" \
  --set name="${NAME}" \
  --set namespace="${NAMESPACE}" \
  --set credentials.secret="${CREDS_SECRET}" \
  --set image=local-registry:5000/valkey:latest \
  --set cluster.reconcilerImage=local-registry:5000/valkey-reconciler:latest \
  --set cluster.masters=2 \
  --set cluster.replicasPerMaster=1 \
  --set hooks.restartPolicy=Never \
  --set hooks.hookDeletePolicy=before-hook-creation \
  --timeout 15m > /dev/null
test_assert "init hook job completed" sh -c \
  "kubectl get job valkey-${NAME}-init -n ${NAMESPACE} -o jsonpath='{.status.succeeded}' | grep -q 1"
test_wait_for 120 "all 4 pods ready" vk_sts_ready 4
test_wait_for 120 "cluster healthy (size=2, nodes=4, slots covered)" vk_healthy 4 2

test_case "failover: master pod loss recovers, manual failover promotes the replica"
master=$(vk_find_master)
kubectl delete pod "${master}" -n "${NAMESPACE}" --wait=false > /dev/null
test_wait_for 180 "cluster recovered (state ok on all nodes)" vk_healthy 4 2
test_wait_for 60 "2 masters + 2 replicas after recovery" vk_roles_balanced
master=$(vk_find_master)
replica=$(vk_replica_of "${master}")
vk_cli "${replica}" cluster failover > /dev/null
test_wait_for 60 "replica promoted to master" vk_role_is "${replica}" master
test_wait_for 60 "old master demoted to replica" vk_role_is "${master}" slave
test_wait_for 120 "cluster healthy after failover" vk_healthy 4 2

test_case "scale up to 3 masters"
vk_upgrade --set cluster.masters=3
test_wait_for 120 "6 pods ready" vk_sts_ready 6
test_wait_for 180 "cluster healthy (size=3, nodes=6, slots covered)" vk_healthy 6 3

test_case "scale down to 2 masters"
vk_upgrade --set cluster.masters=2
test_wait_for 180 "4 pods ready" vk_sts_ready 4
test_wait_for 180 "cluster healthy (size=2, nodes=4, slots covered)" vk_healthy 4 2
