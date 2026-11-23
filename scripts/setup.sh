#!/bin/sh
# shellcheck shell=sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."
readonly SCRIPT_DIR
readonly REPO_ROOT

. "${REPO_ROOT}/scripts/lib/font.sh"
. "${REPO_ROOT}/scripts/lib/log.sh"
. "${REPO_ROOT}/scripts/lib/ui.sh"
. "${REPO_ROOT}/scripts/lib/aws.sh"

usage() {
  printf "Usage: %s\n\nSets up this machine for development: installs mise tools and pnpm\ndependencies, signs into AWS SSO, configures the Pulumi state profile,\nand verifies Pulumi state access.\n" "$0"
}

ensure_mise_tools() {
  command -v mise > /dev/null 2>&1 || die "mise is required: https://mise.jdx.dev/installing-mise.html"
  mise trust --quiet "${REPO_ROOT}/mise.toml"

  ensure_mise_tools_missing=$(mise ls --missing --no-header)
  if [ -z "${ensure_mise_tools_missing}" ]; then
    print_ok "mise tools"
  else
    ensure_mise_tools_log=$(mktemp)
    if ! mise install --yes > "${ensure_mise_tools_log}" 2>&1; then
      cat "${ensure_mise_tools_log}" >&2
      rm -f "${ensure_mise_tools_log}"
      die "mise install failed"
    fi
    rm -f "${ensure_mise_tools_log}"
    print_added "mise tools"
  fi

  # NOTE: activate mise in this shell so ./scripts/setup.sh works before shell integration
  ensure_mise_tools_env=$(mise env -s bash)
  eval "${ensure_mise_tools_env}"
}

ensure_pnpm_dependencies() {
  ensure_pnpm_dependencies_had_modules=0
  [ -d "${REPO_ROOT}/node_modules" ] && ensure_pnpm_dependencies_had_modules=1

  ensure_pnpm_dependencies_log=$(mktemp)
  if ! pnpm install > "${ensure_pnpm_dependencies_log}" 2>&1; then
    cat "${ensure_pnpm_dependencies_log}" >&2
    rm -f "${ensure_pnpm_dependencies_log}"
    die "pnpm install failed"
  fi
  rm -f "${ensure_pnpm_dependencies_log}"

  if [ "${ensure_pnpm_dependencies_had_modules}" -eq 1 ]; then
    print_ok "pnpm dependencies"
  else
    print_added "pnpm dependencies"
  fi
}

verify_pulumi_state() {
  verify_pulumi_state_log=$(mktemp)
  if ! pulumi stack ls > "${verify_pulumi_state_log}" 2>&1; then
    cat "${verify_pulumi_state_log}" >&2
    rm -f "${verify_pulumi_state_log}"
    die "Could not access Pulumi state bucket ${PULUMI_BUCKET}"
  fi
  rm -f "${verify_pulumi_state_log}"
  print_ok "Pulumi state (${PULUMI_BUCKET})"
}

cleanup_on_exit() {
  cleanup_device_login
  for cleanup_on_exit_file in "${ensure_mise_tools_log:-}" "${ensure_pnpm_dependencies_log:-}" "${verify_pulumi_state_log:-}"; do
    [ -n "${cleanup_on_exit_file}" ] && rm -f "${cleanup_on_exit_file}"
  done
}

main() {
  case "${1:-}" in
    '') ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac

  trap 'cleanup_on_exit' EXIT
  trap 'exit 130' INT TERM
  cd "${REPO_ROOT}"

  read_pulumi_config
  print_banner "Dev Setup" "${PULUMI_AWS_REGION} · ${PULUMI_BUCKET}"

  print_section "Toolchain & Dependencies"
  ensure_mise_tools
  ensure_pnpm_dependencies

  print_section "AWS & Pulumi"
  ensure_aws_sso_profile "${AWS_PROFILE}"
  ensure_aws_login
  verify_aws_account dev
  ensure_pulumi_state_profile "${PULUMI_AWS_REGION}"
  verify_pulumi_state

  print_footer "Setup complete"
}

main "$@"
