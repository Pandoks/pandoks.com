# shellcheck shell=sh

readonly PULUMI_STATE_PROFILE='pandoks-pulumi-state'
readonly PULUMI_SSM_READ_WRITE_NAME='/pulumi/r2-state-credentials'

read_pulumi_config() {
  PULUMI_BUCKET=$(sed -n 's|^  url: s3://\([^?]*\)?.*|\1|p' Pulumi.yaml)
  PULUMI_CLOUDFLARE_ACCOUNT_ID=$(sed -n 's|^  url: .*endpoint=\([0-9a-f]*\)\.r2\.cloudflarestorage\.com.*|\1|p' Pulumi.yaml)
  PULUMI_AWS_REGION=$(sed -n '/^  aws:region:$/{n;s|^    value: ||p;}' Pulumi.yaml)
  [ -n "${PULUMI_BUCKET}" ] && [ -n "${PULUMI_CLOUDFLARE_ACCOUNT_ID}" ] && [ -n "${PULUMI_AWS_REGION}" ] \
    || die "Could not read the bucket, Cloudflare account and AWS region from Pulumi.yaml"
}

ensure_aws_sso_profile() {
  ensure_aws_sso_profile_name="${AWS_PROFILE:-pandoks}"
  if aws configure list-profiles 2> /dev/null | grep -qx "${ensure_aws_sso_profile_name}"; then
    print_ok "AWS profile ${ensure_aws_sso_profile_name}"
  else
    [ -t 0 ] || die "AWS profile '${ensure_aws_sso_profile_name}' is not configured. Run 'aws configure sso --profile ${ensure_aws_sso_profile_name}' interactively, then rerun."
    printf "%b│%b\n" "${DIM}" "${NORMAL}" >&2
    printf "%b│%b  %bConfigure AWS SSO%b %b(use SSO session name '%s')%b\n" "${DIM}" "${NORMAL}" "${BOLD}" "${NORMAL}" "${DIM}" "${ensure_aws_sso_profile_name}" "${NORMAL}" >&2
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
