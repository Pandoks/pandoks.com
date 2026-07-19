#!/bin/sh
# shellcheck shell=sh

set -eu

ROOT="${DEV_VPS_ROOT:-}"
TEST_MODE="${DEV_VPS_TEST_MODE:-0}"

path() {
  printf "%s%s" "${ROOT}" "$1"
}

require_root() {
  if [ "${TEST_MODE}" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
    printf "Run this command as root.\n" >&2
    exit 1
  fi
}

require_ubuntu() {
  if [ "${TEST_MODE}" -eq 0 ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    detected_id="${ID:-unknown}"
    detected_version="${VERSION_ID:-unknown}"
    if [ "${detected_id}" != "ubuntu" ] || [ "${detected_version}" != "26.04" ]; then
      printf "This setup requires Ubuntu 26.04; found ID=%s VERSION_ID=%s.\n" \
        "${detected_id}" "${detected_version}" >&2
      exit 1
    fi
  fi
}

write_sudoers() {
  install -d -m 0755 "$(path /etc/sudoers.d)"
  sudoers_file="$(path /etc/sudoers.d/pandoks)"
  sudoers_temp="$(mktemp "${sudoers_file}.XXXXXX")"

  printf "pandoks ALL=(ALL) NOPASSWD:ALL\n" > "${sudoers_temp}"
  chmod 0440 "${sudoers_temp}"
  mv -f "${sudoers_temp}" "${sudoers_file}"
}

write_ssh_lockdown() {
  install -d -m 0755 "$(path /etc/ssh/sshd_config.d)"
  cat > "$(path /etc/ssh/sshd_config.d/99-pandoks.conf)" << 'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin no
AllowUsers pandoks
EOF
  chmod 0644 "$(path /etc/ssh/sshd_config.d/99-pandoks.conf)"
}

write_firewall() {
  install -d -m 0755 "$(path /etc)"
  cat > "$(path /etc/nftables.conf)" << 'EOF'
#!/usr/sbin/nft -f

flush ruleset

table inet filter {
  chain input {
    type filter hook input priority -100; policy drop;

    ct state established,related accept comment "Return traffic"
    ct state invalid drop comment "Invalid packets"
    iifname "lo" accept comment "Loopback"
    iifname "tailscale0" tcp dport 22 accept comment "Tailscale SSH"
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
  chmod 0755 "$(path /etc/nftables.conf)"
}

prepare() {
  require_root
  require_ubuntu

  if [ "${TEST_MODE}" -eq 0 ]; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
      ca-certificates curl git nftables sudo

    if ! id pandoks > /dev/null 2>&1; then
      useradd --create-home --shell /bin/bash --groups sudo pandoks
    fi
  fi

  write_sudoers

  if [ "${TEST_MODE}" -eq 0 ] && ! command -v tailscale > /dev/null 2>&1; then
    install_script="$(mktemp)"
    curl -fsSL https://tailscale.com/install.sh -o "${install_script}"
    sh "${install_script}"
    rm -f "${install_script}"
  fi

  if [ "${TEST_MODE}" -eq 0 ] && ! tailscale ip -4 > /dev/null 2>&1; then
    tailscale up \
      --ssh \
      --hostname=pandoks-dev-box \
      --accept-dns=false \
      --advertise-tags=tag:ovh,tag:dev
  fi

  printf "Preparation complete. Verify Tailscale SSH from another terminal.\n"
  printf "Then run: sudo %s verify-tailscale\n" "$0"
}

verify_tailscale() {
  require_root
  if [ "${TEST_MODE}" -eq 0 ]; then
    tailscale ip -4 > /dev/null
    ip link show tailscale0 > /dev/null
  fi
  install -d -m 0755 "$(path /run)"
  : > "$(path /run/tailscale-ssh-verified)"
  printf "Tailscale verification marker created for this boot.\n"
}

lockdown() {
  require_root
  require_ubuntu

  if [ ! -f "$(path /run/tailscale-ssh-verified)" ]; then
    printf "Refusing lockdown: run verify-tailscale after proving Tailscale SSH.\n" >&2
    exit 1
  fi

  if [ "${TEST_MODE}" -eq 0 ]; then
    tailscale ip -4 > /dev/null
    ip link show tailscale0 > /dev/null
  fi

  write_ssh_lockdown
  write_firewall

  if [ "${TEST_MODE}" -eq 0 ]; then
    sshd -t
    nft --check --file /etc/nftables.conf
    systemctl reload ssh
    systemctl enable nftables
    nft --file /etc/nftables.conf
  fi

  printf "Lockdown complete. Public SSH is blocked; use Tailscale SSH.\n"
}

status() {
  if [ "${TEST_MODE}" -eq 0 ]; then
    tailscale status
    nft list ruleset
    sshd -T | grep -E '^(passwordauthentication|permitrootlogin|allowusers) '
  else
    test -f "$(path /etc/nftables.conf)"
    test -f "$(path /etc/ssh/sshd_config.d/99-pandoks.conf)"
  fi
}

usage() {
  printf "Usage: %s prepare|verify-tailscale|lockdown|status\n" "$0" >&2
  exit "${1:-0}"
}

main() {
  [ "$#" -eq 1 ] || usage 1
  case "$1" in
    prepare) prepare ;;
    verify-tailscale) verify_tailscale ;;
    lockdown) lockdown ;;
    status) status ;;
    help | --help | -h) usage 0 ;;
    *) usage 1 ;;
  esac
}

main "$@"
