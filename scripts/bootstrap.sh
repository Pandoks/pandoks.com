#!/bin/sh
# shellcheck shell=sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."
readonly SCRIPT_DIR
readonly REPO_ROOT

. "${REPO_ROOT}/scripts/lib/font.sh"
. "${REPO_ROOT}/scripts/lib/log.sh"
. "${REPO_ROOT}/scripts/lib/prompt.sh"

readonly AWS_PROFILE_NAME='pandoks-pulumi-state'
readonly KMS_PRODUCTION_ALIAS='pulumi-production'
readonly KMS_NONPRODUCTION_ALIAS='pulumi-nonproduction'
readonly SSM_READ_WRITE_NAME='/pulumi/r2-state-credentials'
readonly SSM_READ_ONLY_NAME='/pulumi/r2-state-read-credentials'
readonly GITHUB_OIDC_HOST='token.actions.githubusercontent.com'
readonly CI_ROLE_NAME='PandoksGithubActions'

print_banner() {
  printf "\n%b┌%b  %bpandoks.com%b %b· Pulumi Bootstrap%b\n" "${DIM}" "${NORMAL}" "${BOLD}" "${NORMAL}" "${DIM}" "${NORMAL}"
  printf "%b│%b  %b%s · %s%b\n" "${DIM}" "${NORMAL}" "${DIM}" "$1" "$2" "${NORMAL}"
}

print_section() {
  printf "%b│%b\n" "${DIM}" "${NORMAL}"
  printf "%b◇%b  %b%s%b\n" "${CYAN}" "${NORMAL}" "${BOLD}" "$1" "${NORMAL}"
}

print_ok() {
  printf "%b│%b  %b✓%b %s\n" "${DIM}" "${NORMAL}" "${GREEN}" "${NORMAL}" "$*"
}

print_added() {
  printf "%b│%b  %b+%b %s\n" "${DIM}" "${NORMAL}" "${CYAN}" "${NORMAL}" "$*"
}

print_footer() {
  printf "%b│%b\n" "${DIM}" "${NORMAL}"
  printf "%b└%b  %b✓%b %b%s%b\n\n" "${DIM}" "${NORMAL}" "${GREEN}" "${NORMAL}" "${BOLD}" "$1" "${NORMAL}"
}

ensure_aws_login() {
  if aws sts get-caller-identity > /dev/null 2>&1; then
    print_ok "AWS login"
  else
    pnpm sso
    print_added "AWS login"
  fi
}

ensure_cloudflare_login() {
  ensure_cloudflare_login_account_id=$1

  if ensure_cloudflare_login_whoami=$(wrangler whoami --json 2> /dev/null); then
    print_ok "Cloudflare login"
  else
    wrangler login --device --browser=false
    ensure_cloudflare_login_whoami=$(wrangler whoami --json)
    print_added "Cloudflare login"
  fi

  printf '%s\n' "${ensure_cloudflare_login_whoami}" \
    | jq -e --arg accountId "${ensure_cloudflare_login_account_id}" '.accounts[] | select(.id == $accountId)' > /dev/null \
    || die "Cloudflare logins don't include account ${ensure_cloudflare_login_account_id}; log in to it, or fix the endpoint in the backend.url line of Pulumi.yaml"
}

ensure_r2_bucket() {
  ensure_r2_bucket_name=$1
  ensure_r2_bucket_account_id=$2

  # NOTE: wrangler asks which account to use when several are logged in, so every call names one
  # TODO: lists only 20 buckets: https://github.com/cloudflare/workers-sdk/issues/15103
  ensure_r2_bucket_list=$(CLOUDFLARE_ACCOUNT_ID="${ensure_r2_bucket_account_id}" wrangler r2 bucket list)
  if printf '%s\n' "${ensure_r2_bucket_list}" | grep "^name: *${ensure_r2_bucket_name}\$" > /dev/null; then
    print_ok "R2 bucket ${ensure_r2_bucket_name}"
  else
    CLOUDFLARE_ACCOUNT_ID="${ensure_r2_bucket_account_id}" wrangler r2 bucket create "${ensure_r2_bucket_name}"
    print_added "R2 bucket ${ensure_r2_bucket_name}"
  fi
}

ensure_kms_alias() {
  ensure_kms_alias_name=$1
  ensure_kms_alias_region=$2
  ensure_kms_alias_description=$3

  ensure_kms_alias_count=$(aws kms list-aliases --region "${ensure_kms_alias_region}" --query "length(Aliases[?AliasName=='alias/${ensure_kms_alias_name}'])" --output json)
  if [ "${ensure_kms_alias_count}" -gt 0 ]; then
    print_ok "KMS alias/${ensure_kms_alias_name}"
  else
    ensure_kms_alias_key_id=$(aws kms create-key --region "${ensure_kms_alias_region}" --description "${ensure_kms_alias_description}" --query KeyMetadata.KeyId --output text)
    if ! aws kms create-alias --region "${ensure_kms_alias_region}" --alias-name "alias/${ensure_kms_alias_name}" --target-key-id "${ensure_kms_alias_key_id}"; then
      aws kms schedule-key-deletion --region "${ensure_kms_alias_region}" --key-id "${ensure_kms_alias_key_id}" --pending-window-in-days 7 > /dev/null
      die "Could not create alias/${ensure_kms_alias_name}; scheduled deletion of its new key ${ensure_kms_alias_key_id}"
    fi
    print_added "KMS alias/${ensure_kms_alias_name}"
  fi
}

ensure_r2_token_parameter() {
  ensure_r2_token_parameter_name=$1
  ensure_r2_token_parameter_permission=$2
  ensure_r2_token_parameter_region=$3
  ensure_r2_token_parameter_account_id=$4
  ensure_r2_token_parameter_bucket=$5

  # NOTE: describe instead of get-parameter --with-decryption, so checking never reads the token
  ensure_r2_token_parameter_count=$(aws ssm describe-parameters --region "${ensure_r2_token_parameter_region}" --parameter-filters "Key=Name,Option=Equals,Values=${ensure_r2_token_parameter_name}" --query 'length(Parameters)' --output json)
  if [ "${ensure_r2_token_parameter_count}" -gt 0 ]; then
    print_ok "SSM ${ensure_r2_token_parameter_name}"
  else
    printf "%b│%b  Create an R2 API token (%s) for %s:\n" "${DIM}" "${NORMAL}" "${ensure_r2_token_parameter_permission}" "${ensure_r2_token_parameter_bucket}" >&2
    printf "%b│%b  %bhttps://dash.cloudflare.com/%s/r2/api-tokens%b\n" "${DIM}" "${NORMAL}" "${CYAN}" "${ensure_r2_token_parameter_account_id}" "${NORMAL}" >&2
    printf "%b│%b\n" "${DIM}" "${NORMAL}" >&2
    ensure_r2_token_parameter_access_key_id=$(prompt_secret "$(printf "%b│%b  Access Key ID: " "${DIM}" "${NORMAL}")")
    ensure_r2_token_parameter_secret=$(prompt_secret "$(printf "%b│%b  Secret Access Key: " "${DIM}" "${NORMAL}")")
    if [ -z "${ensure_r2_token_parameter_access_key_id}" ] || [ -z "${ensure_r2_token_parameter_secret}" ]; then
      die "Access Key ID and Secret Access Key can't be empty"
    fi

    store_token_parameter "${ensure_r2_token_parameter_name}" "${ensure_r2_token_parameter_region}" "${ensure_r2_token_parameter_access_key_id}" "${ensure_r2_token_parameter_secret}"
    print_added "SSM ${ensure_r2_token_parameter_name}"
  fi
}

store_token_parameter() {
  store_token_parameter_name=$1
  store_token_parameter_region=$2
  store_token_parameter_access_key_id=$3
  store_token_parameter_secret=$4

  store_token_parameter_file=$(umask 077 && mktemp)
  printf '{"Version":1,"AccessKeyId":"%s","SecretAccessKey":"%s"}\n' "${store_token_parameter_access_key_id}" "${store_token_parameter_secret}" > "${store_token_parameter_file}"
  aws ssm put-parameter --region "${store_token_parameter_region}" --type SecureString --key-id "alias/${KMS_PRODUCTION_ALIAS}" --name "${store_token_parameter_name}" --value "file://${store_token_parameter_file}" > /dev/null
  rm -f "${store_token_parameter_file}"
}

ensure_aws_profile() {
  ensure_aws_profile_region=$1
  ensure_aws_profile_credential_process="aws ssm get-parameter --region ${ensure_aws_profile_region} --name ${SSM_READ_WRITE_NAME} --with-decryption --query Parameter.Value --output text"

  if [ "$(aws configure get "profile.${AWS_PROFILE_NAME}.region" 2> /dev/null)" = auto ] \
    && [ "$(aws configure get "profile.${AWS_PROFILE_NAME}.credential_process" 2> /dev/null)" = "${ensure_aws_profile_credential_process}" ]; then
    print_ok "AWS profile ${AWS_PROFILE_NAME}"
  else
    aws configure set "profile.${AWS_PROFILE_NAME}.region" auto
    aws configure set "profile.${AWS_PROFILE_NAME}.credential_process" "${ensure_aws_profile_credential_process}"
    print_added "AWS profile ${AWS_PROFILE_NAME}"
  fi
}

ensure_github_oidc_provider() {
  ensure_github_oidc_provider_count=$(aws iam list-open-id-connect-providers --query "length(OpenIDConnectProviderList[?ends_with(Arn, '${GITHUB_OIDC_HOST}')])" --output json)
  if [ "${ensure_github_oidc_provider_count}" -gt 0 ]; then
    print_ok "GitHub OIDC provider"
  else
    aws iam create-open-id-connect-provider --url "https://${GITHUB_OIDC_HOST}" --client-id-list sts.amazonaws.com > /dev/null
    print_added "GitHub OIDC provider"
  fi
}

ensure_github_role() {
  ensure_github_role_account_id=$1
  ensure_github_role_repo=$2

  ensure_github_role_count=$(aws iam list-roles --query "length(Roles[?RoleName=='${CI_ROLE_NAME}'])" --output json)
  if [ "${ensure_github_role_count}" -gt 0 ]; then
    print_ok "IAM role ${CI_ROLE_NAME}"
  else
    ensure_github_role_trust_policy=$(
      cat << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::${ensure_github_role_account_id}:oidc-provider/${GITHUB_OIDC_HOST}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${GITHUB_OIDC_HOST}:aud": "sts.amazonaws.com",
          "${GITHUB_OIDC_HOST}:sub": [
            "repo:${ensure_github_role_repo}:environment:production",
            "repo:${ensure_github_role_repo}:ref:refs/heads/main"
          ]
        }
      }
    }
  ]
}
EOF
    )
    aws iam create-role --role-name "${CI_ROLE_NAME}" --assume-role-policy-document "${ensure_github_role_trust_policy}" > /dev/null
    print_added "IAM role ${CI_ROLE_NAME}"
  fi

  ensure_github_role_policy_count=$(aws iam list-attached-role-policies --role-name "${CI_ROLE_NAME}" --query "length(AttachedPolicies[?PolicyArn=='arn:aws:iam::aws:policy/AdministratorAccess'])" --output json)
  if [ "${ensure_github_role_policy_count}" -gt 0 ]; then
    print_ok "AdministratorAccess on ${CI_ROLE_NAME}"
  else
    aws iam attach-role-policy --role-name "${CI_ROLE_NAME}" --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
    print_added "AdministratorAccess on ${CI_ROLE_NAME}"
  fi
}

ensure_github_variable() {
  ensure_github_variable_repo=$1
  ensure_github_variable_name=$2
  ensure_github_variable_value=$3

  ensure_github_variable_current=$(gh variable list --repo "${ensure_github_variable_repo}" --json name,value --jq ".[] | select(.name == \"${ensure_github_variable_name}\") | .value")
  if [ "${ensure_github_variable_current}" = "${ensure_github_variable_value}" ]; then
    print_ok "GitHub variable ${ensure_github_variable_name}"
  elif [ -n "${ensure_github_variable_current}" ]; then
    die "GitHub variable ${ensure_github_variable_name} is ${ensure_github_variable_current}, not ${ensure_github_variable_value}; check your AWS profile, or delete the variable to replace it"
  else
    gh variable set "${ensure_github_variable_name}" --repo "${ensure_github_variable_repo}" --body "${ensure_github_variable_value}"
    print_added "GitHub variable ${ensure_github_variable_name}"
  fi
}

cleanup_on_exit() {
  if [ -n "${store_token_parameter_file:-}" ]; then
    rm -f "${store_token_parameter_file}"
  fi
  if [ -t 0 ]; then
    stty echo
  fi
}

main() {
  trap 'cleanup_on_exit' EXIT
  trap 'exit 130' INT TERM
  cd "${REPO_ROOT}"

  main_bucket=$(sed -n 's|^  url: s3://\([^?]*\)?.*|\1|p' Pulumi.yaml)
  main_cloudflare_account_id=$(sed -n 's|^  url: .*endpoint=\([0-9a-f]*\)\.r2\.cloudflarestorage\.com.*|\1|p' Pulumi.yaml)
  main_region=$(sed -n '/^  aws:region:$/{n;s|^    value: ||p;}' Pulumi.yaml)
  [ -n "${main_bucket}" ] && [ -n "${main_cloudflare_account_id}" ] && [ -n "${main_region}" ] \
    || die "Could not read the bucket, Cloudflare account and AWS region from Pulumi.yaml"
  main_repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

  print_banner "${main_region}" "${main_bucket}"

  print_section "Auth & GitHub"
  ensure_aws_login
  main_aws_account_id=$(aws sts get-caller-identity --query Account --output text)
  # NOTE: first, so a wrong AWS_PROFILE dies here before writing to that account
  ensure_github_variable "${main_repo}" AWS_ROLE_ARN "arn:aws:iam::${main_aws_account_id}:role/${CI_ROLE_NAME}"
  ensure_github_variable "${main_repo}" AWS_REGION "${main_region}"
  ensure_cloudflare_login "${main_cloudflare_account_id}"

  print_section "State & Encryption"
  ensure_r2_bucket "${main_bucket}" "${main_cloudflare_account_id}"
  ensure_kms_alias "${KMS_PRODUCTION_ALIAS}" "${main_region}" "Pulumi secrets for the production stack"
  ensure_kms_alias "${KMS_NONPRODUCTION_ALIAS}" "${main_region}" "Pulumi secrets for non-production stacks"

  print_section "R2 State Tokens"
  ensure_r2_token_parameter "${SSM_READ_WRITE_NAME}" "Object Read & Write" "${main_region}" "${main_cloudflare_account_id}" "${main_bucket}"
  ensure_r2_token_parameter "${SSM_READ_ONLY_NAME}" "Object Read only" "${main_region}" "${main_cloudflare_account_id}" "${main_bucket}"

  print_section "Local Profile & CI Role"
  ensure_aws_profile "${main_region}"
  ensure_github_oidc_provider
  ensure_github_role "${main_aws_account_id}" "${main_repo}"

  print_footer "Bootstrap complete"
}

main
