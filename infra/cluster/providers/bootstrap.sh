#!/bin/sh
# shellcheck shell=sh

set -eu

# PANDOKS_BOOTSTRAP_ENVIRONMENT

DONE_FILE=/var/lib/pandoks/cluster-bootstrap.complete
TAILSCALE_INSTALL=/tmp/tailscale-install.sh
K3S_INSTALL=/tmp/k3s-install.sh
K3S_VERSION='v1.36.2+k3s1'

log() {
  printf "pandoks-bootstrap: %s\n" "$*"
}

retry() {
  retry_attempts="$1"
  retry_delay="$2"
  shift 2
  retry_index=1
  while ! "$@"; do
    if [ "${retry_index}" -ge "${retry_attempts}" ]; then
      return 1
    fi
    retry_index=$((retry_index + 1))
    sleep "${retry_delay}"
  done
}

install_packages() {
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl nftables sudo
}

configure_admin() {
  if ! id pandoks > /dev/null 2>&1; then
    useradd --create-home --shell /bin/bash --groups sudo pandoks
  fi
  install -d -m 0755 /etc/sudoers.d /etc/ssh/sshd_config.d
  printf "pandoks ALL=(ALL) NOPASSWD:ALL\n" > /etc/sudoers.d/pandoks
  chmod 0440 /etc/sudoers.d/pandoks
  cat > /etc/ssh/sshd_config.d/99-pandoks.conf << 'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin no
AllowUsers pandoks
EOF
  sshd -t
  systemctl reload ssh
}

interface_for_mac() {
  expected_mac="$(printf "%s" "$1" | tr '[:upper:]' '[:lower:]')"
  for address_file in /sys/class/net/*/address; do
    if [ "$(cat "${address_file}")" = "${expected_mac}" ]; then
      basename "$(dirname "${address_file}")"
      return 0
    fi
  done
  return 1
}

interface_for_ip() {
  ip -o -4 addr show \
    | awk -v expected="${NODE_IP}/" '$4 ~ "^" expected { print $2; exit }'
}

configure_private_network() {
  if [ "${NETWORK_MODE}" = "static" ]; then
    VRACK_INTERFACE="$(retry 60 5 interface_for_mac "${VRACK_MAC}")"
    NETWORK_PREFIX_LENGTH="${NETWORK_CIDR##*/}"
    cat > /etc/netplan/60-k3s-vrack.yaml << EOF
network:
  version: 2
  ethernets:
    vrack:
      match:
        macaddress: ${VRACK_MAC}
      set-name: vrack0
      addresses:
        - ${NODE_IP}/${NETWORK_PREFIX_LENGTH}
EOF
    chmod 0600 /etc/netplan/60-k3s-vrack.yaml
    netplan apply
    VRACK_INTERFACE=vrack0
  else
    VRACK_INTERFACE="$(retry 60 5 interface_for_ip)"
  fi
  export VRACK_INTERFACE
  ip link show "${VRACK_INTERFACE}" > /dev/null
  ip -4 addr show dev "${VRACK_INTERFACE}" | grep -q "${NODE_IP}/"
}

configure_firewall() {
  cat > /etc/nftables.conf << EOF
#!/usr/sbin/nft -f

flush ruleset

table inet filter {
  chain input {
    type filter hook input priority -100; policy drop;

    ct state established,related accept comment "Return traffic"
    ct state invalid drop comment "Invalid packets"
    iifname "lo" accept comment "Loopback"
    iifname "tailscale0" tcp dport 22 accept comment "Tailscale SSH"
    iifname "cni0" accept comment "k3s CNI"
    iifname "flannel.1" accept comment "k3s Flannel"
    iifname "${VRACK_INTERFACE}" ip saddr ${NETWORK_CIDR} accept comment "OVH vRack"
    udp dport 41641 accept comment "Direct Tailscale"
    ip6 nexthdr ipv6-icmp accept comment "Required ICMPv6"
    limit rate 5/minute counter log prefix "nft-drop: "
    counter drop
  }

  chain forward {
    type filter hook forward priority filter; policy accept;
  }

  chain output {
    type filter hook output priority filter; policy accept;
  }
}
EOF
  chmod 0755 /etc/nftables.conf
  nft --check --file /etc/nftables.conf
  systemctl enable nftables
  nft --file /etc/nftables.conf
}

configure_tailscale() {
  if ! command -v tailscale > /dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh -o "${TAILSCALE_INSTALL}"
    sh "${TAILSCALE_INSTALL}"
    rm -f "${TAILSCALE_INSTALL}"
  fi
  if ! tailscale ip -4 > /dev/null 2>&1; then
    tailscale up \
      --ssh \
      --auth-key="${REGISTRATION_TAILNET_AUTH_KEY}" \
      --hostname="${NODE_NAME}" \
      --accept-dns=false
  fi
  unset REGISTRATION_TAILNET_AUTH_KEY
}

api_ready() {
  curl --connect-timeout 3 --max-time 5 --silent --show-error --fail \
    --insecure "${SERVER_API}/readyz" > /dev/null
}

download_k3s_installer() {
  export INSTALL_K3S_VERSION="${K3S_VERSION}"
  curl -sfL https://get.k3s.io -o "${K3S_INSTALL}"
  chmod 0755 "${K3S_INSTALL}"
}

install_control_plane() {
  download_k3s_installer
  if [ "${BOOTSTRAP_CANDIDATE}" = "true" ] && ! api_ready; then
    K3S_TOKEN="${K3S_TOKEN}" sh "${K3S_INSTALL}" server \
      --cluster-init \
      --disable=traefik \
      --disable=servicelb \
      --node-ip="${NODE_IP}" \
      --advertise-address="${NODE_IP}" \
      --tls-san="${NODE_IP}" \
      --tls-san="$(printf "%s" "${SERVER_API}" | sed -e 's#^https://##' -e 's#:6443$##')" \
      --flannel-iface="${VRACK_INTERFACE}" \
      --etcd-expose-metrics \
      --etcd-s3 \
      --etcd-s3-endpoint="${S3_HOST}" \
      --etcd-s3-bucket="${BACKUP_BUCKET}" \
      --etcd-s3-access-key="${S3_ACCESS_KEY}" \
      --etcd-s3-secret-key="${S3_SECRET_KEY}" \
      --etcd-s3-folder=kubernetes/etcd \
      --etcd-snapshot-schedule-cron="0 */6 * * *" \
      --etcd-snapshot-retention=5
  else
    retry 120 5 api_ready
    K3S_TOKEN="${K3S_TOKEN}" sh "${K3S_INSTALL}" server \
      --server="${SERVER_API}" \
      --disable=traefik \
      --disable=servicelb \
      --node-ip="${NODE_IP}" \
      --advertise-address="${NODE_IP}" \
      --tls-san="${NODE_IP}" \
      --tls-san="$(printf "%s" "${SERVER_API}" | sed -e 's#^https://##' -e 's#:6443$##')" \
      --flannel-iface="${VRACK_INTERFACE}" \
      --etcd-expose-metrics \
      --etcd-s3 \
      --etcd-s3-endpoint="${S3_HOST}" \
      --etcd-s3-bucket="${BACKUP_BUCKET}" \
      --etcd-s3-access-key="${S3_ACCESS_KEY}" \
      --etcd-s3-secret-key="${S3_SECRET_KEY}" \
      --etcd-s3-folder=kubernetes/etcd \
      --etcd-snapshot-schedule-cron="0 */6 * * *" \
      --etcd-snapshot-retention=5
  fi
  rm -f "${K3S_INSTALL}"
}

install_worker() {
  retry 120 5 api_ready
  download_k3s_installer
  K3S_TOKEN="${K3S_TOKEN}" sh "${K3S_INSTALL}" agent \
    --server="${SERVER_API}" \
    --node-ip="${NODE_IP}" \
    --flannel-iface="${VRACK_INTERFACE}"
  rm -f "${K3S_INSTALL}"
}

install_cluster_resources() {
  [ "${BOOTSTRAP_CANDIDATE}" = "true" ] || return 0
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  retry 120 5 kubectl --request-timeout=5s get --raw=/readyz

  kubectl create secret generic tailscale \
    --namespace kube-system \
    --from-literal=tailscale-oauth="$(
      cat << EOF
oauth:
  clientId: "${KUBERNETES_TAILSCALE_OAUTH_CLIENT_ID}"
  clientSecret: "${KUBERNETES_TAILSCALE_OAUTH_CLIENT_SECRET}"
EOF
    )" \
    --from-literal=operator-config="$(
      cat << EOF
operatorConfig:
  hostname: "${STAGE_NAME}-cluster"
  defaultTags:
    - tag:k8s-operator
    - tag:k8s
    - tag:${STAGE_NAME}
EOF
    )" \
    --dry-run=client -o yaml | kubectl apply --server-side -f -

  kubectl create namespace tailscale \
    --dry-run=client -o yaml | kubectl apply --server-side -f -

  kubectl apply --server-side -f - << 'EOF'
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: tailscale-operator
  namespace: kube-system
spec:
  repo: https://pkgs.tailscale.com/helmcharts
  chart: tailscale-operator
  version: 1.92.5
  targetNamespace: tailscale
  valuesContent: |-
    apiServerProxyConfig:
      mode: "true"
  valuesSecrets:
    - name: tailscale
      keys:
        - tailscale-oauth
        - operator-config
EOF

  kubectl create clusterrolebinding pandoks \
    --user='Pandoks@github' \
    --clusterrole=cluster-admin \
    --dry-run=client -o yaml | kubectl apply --server-side -f -
}

main() {
  if [ -f "${DONE_FILE}" ]; then
    log "already complete"
    exit 0
  fi
  install -d -m 0700 /var/lib/pandoks
  install_packages
  configure_admin
  configure_private_network
  configure_firewall
  configure_tailscale

  if ! systemctl is-active --quiet k3s \
    && ! systemctl is-active --quiet k3s-agent; then
    if [ "${ROLE}" = "control-plane" ]; then
      install_control_plane
    else
      install_worker
    fi
  fi

  if [ "${ROLE}" = "control-plane" ]; then
    install_cluster_resources
  fi

  : > "${DONE_FILE}"
  log "complete"
}

main "$@"
