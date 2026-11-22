# shellcheck shell=sh

readonly PULUMI_SSO_SESSION='pandoks'
readonly PULUMI_STATE_PROFILE='pandoks-pulumi-state'
readonly PULUMI_SSM_READ_WRITE_NAME='/pulumi/r2-state-credentials'

read_pulumi_config() {
  PULUMI_BUCKET=$(sed -n 's|^  url: s3://\([^?]*\)?.*|\1|p' Pulumi.yaml)
  PULUMI_CLOUDFLARE_ACCOUNT_ID=$(sed -n 's|^  url: .*endpoint=\([0-9a-f]*\)\.r2\.cloudflarestorage\.com.*|\1|p' Pulumi.yaml)
  PULUMI_AWS_REGION=$(sed -n '/^  aws:region:$/{n;s|^    value: ||p;}' Pulumi.yaml)
  [ -n "${PULUMI_BUCKET}" ] && [ -n "${PULUMI_CLOUDFLARE_ACCOUNT_ID}" ] && [ -n "${PULUMI_AWS_REGION}" ] \
    || die "Could not read the bucket, Cloudflare account and AWS region from Pulumi.yaml"
}

read_pulumi_allowed_account_id() {
  read_pulumi_allowed_account_id_file="Pulumi.$1.yaml"
  [ -f "${read_pulumi_allowed_account_id_file}" ] || die "Missing ${read_pulumi_allowed_account_id_file}"
  sed -n "/^  aws:allowedAccountIds:$/{n;s/^    - ['\"]*\\([0-9]*\\)['\"]*$/\\1/p;}" "${read_pulumi_allowed_account_id_file}"
}

ensure_aws_sso_profile() {
  ensure_aws_sso_profile_name="${1:-${AWS_PROFILE:-pandoks-dev}}"
  if aws configure list-profiles 2> /dev/null | grep -qx "${ensure_aws_sso_profile_name}"; then
    print_ok "AWS profile ${ensure_aws_sso_profile_name}"
  else
    [ -t 0 ] || die "AWS profile '${ensure_aws_sso_profile_name}' is not configured. Run 'aws configure sso --profile ${ensure_aws_sso_profile_name}' interactively, then rerun."
    printf "%b│%b\n" "${DIM}" "${NORMAL}" >&2
    printf "%b│%b  %bConfigure AWS SSO%b %b(use SSO session name '%s')%b\n" "${DIM}" "${NORMAL}" "${BOLD}" "${NORMAL}" "${DIM}" "${PULUMI_SSO_SESSION}" "${NORMAL}" >&2
    printf "%b│%b\n" "${DIM}" "${NORMAL}" >&2
    aws configure sso --profile "${ensure_aws_sso_profile_name}" --use-device-code --no-browser
    print_added "AWS profile ${ensure_aws_sso_profile_name}"
  fi
}

ensure_aws_login() {
  if aws sts get-caller-identity > /dev/null 2>&1; then
    print_ok "AWS login"
  else
    run_device_login "AWS SSO" pnpm sso
    print_added "AWS login"
  fi
}

verify_aws_account() {
  verify_aws_account_stack=$1
  verify_aws_account_expected=$(read_pulumi_allowed_account_id "${verify_aws_account_stack}")
  [ -n "${verify_aws_account_expected}" ] || die "Could not read aws:allowedAccountIds from Pulumi.${verify_aws_account_stack}.yaml"
  verify_aws_account_actual=$(aws sts get-caller-identity --query Account --output text)
  [ "${verify_aws_account_actual}" = "${verify_aws_account_expected}" ] \
    || die "AWS profile '${AWS_PROFILE:-default}' is account ${verify_aws_account_actual}, expected ${verify_aws_account_expected} (${verify_aws_account_stack})"
  print_ok "AWS account ${verify_aws_account_actual} (${verify_aws_account_stack})"
}

ensure_pulumi_state_profile() {
  ensure_pulumi_state_profile_region=$1
  ensure_pulumi_state_profile_credential_process="aws ssm get-parameter --region ${ensure_pulumi_state_profile_region} --name ${PULUMI_SSM_READ_WRITE_NAME} --with-decryption --query Parameter.Value --output text"

  if [ "$(aws configure get "profile.${PULUMI_STATE_PROFILE}.region" 2> /dev/null)" = auto ] \
    && [ "$(aws configure get "profile.${PULUMI_STATE_PROFILE}.credential_process" 2> /dev/null)" = "${ensure_pulumi_state_profile_credential_process}" ]; then
    print_ok "AWS profile ${PULUMI_STATE_PROFILE}"
  else
    aws configure set "profile.${PULUMI_STATE_PROFILE}.region" auto
    aws configure set "profile.${PULUMI_STATE_PROFILE}.credential_process" "${ensure_pulumi_state_profile_credential_process}"
    print_added "AWS profile ${PULUMI_STATE_PROFILE}"
  fi
}
