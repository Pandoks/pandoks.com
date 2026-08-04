# shellcheck shell=sh

cmd_test_check_cluster() {
  if ! k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    log_error "k3d cluster 'local-cluster' not found."
    printf "Run 'pnpm cluster k3d deps up && pnpm cluster k3d up' first.\n" >&2
    exit 1
  fi
  if [ "$(kubectl config current-context 2> /dev/null)" != "k3d-local-cluster" ]; then
    log_error "kubectl context is not 'k3d-local-cluster'."
    printf "Run 'k3d kubeconfig merge local-cluster --kubeconfig-switch-context' first.\n" >&2
    exit 1
  fi
  if ! docker inspect -f '{{.State.Running}}' s3 2> /dev/null | grep -q true; then
    log_error "localstack container 's3' is not running."
    printf "Run 'pnpm cluster k3d deps up' first.\n" >&2
    exit 1
  fi
}

# Idempotent shared prep: cert-manager + internal CA chain, ServiceMonitor CRD,
# monitoring/main namespaces, database ClusterRoles. Safe to run repeatedly.
cmd_test_prep() {
  echo "Preparing shared cluster test dependencies..."
  helm repo add jetstack https://charts.jetstack.io --force-update > /dev/null
  helm upgrade --install cert-manager jetstack/cert-manager \
    --namespace cert-manager \
    --create-namespace \
    --version v1.19.2 \
    --set installCRDs=true \
    --wait --timeout 5m > /dev/null
  kubectl apply -f "${REPO_ROOT}/k3s/base/core/cert-manager.yaml" > /dev/null
  kubectl wait --for=condition=Ready certificate/internal-root-ca \
    -n cert-manager --timeout=120s > /dev/null
  kubectl apply --server-side -f \
    https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/v0.83.0/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml > /dev/null
  kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f - > /dev/null
  kubectl create namespace main --dry-run=client -o yaml | kubectl apply -f - > /dev/null
  kubectl apply -f "${REPO_ROOT}/k3s/base/core/postgres.yaml" > /dev/null
  kubectl apply -f "${REPO_ROOT}/k3s/base/core/valkey.yaml" > /dev/null
  log_ok "shared cluster test dependencies ready"
}

cmd_test_run_suite() {
  printf "\n"
  echo "Running ${1} cluster test suite..."
  pnpm -C "${REPO_ROOT}" --filter "@pandoks.com/${1}" run test:cluster
}

cmd_test() {
  [ $# -ge 1 ] || usage_test 1
  cmd_test_target=""
  TEST_KEEP=0

  while [ $# -gt 0 ]; do
    case "$1" in
      postgres | valkey | clickhouse | all)
        if [ -n "${cmd_test_target}" ]; then
          log_error "Multiple targets given: '${cmd_test_target}' and '$1'"
          usage_test 1
        fi
        cmd_test_target="$1"
        ;;
      --keep) TEST_KEEP=1 ;;
      help | --help | -h) usage_test ;;
      *)
        log_error "Unknown test argument '$1'"
        usage_test 1
        ;;
    esac
    shift
  done
  [ -n "${cmd_test_target}" ] || usage_test 1
  export TEST_KEEP

  cmd_test_check_cluster
  cmd_test_prep

  if [ "${cmd_test_target}" = "all" ]; then
    cmd_test_run_suite postgres
    cmd_test_run_suite valkey
    cmd_test_run_suite clickhouse
  else
    cmd_test_run_suite "${cmd_test_target}"
  fi
  printf "\n"
  log_ok "cluster tests passed (${cmd_test_target})"
}
