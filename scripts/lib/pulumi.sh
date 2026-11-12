# shellcheck shell=sh

get_pulumi_outputs() {
  get_pulumi_outputs_stack="$1"

  get_pulumi_outputs_passphrase=$(aws ssm get-parameter \
    --name "/sst/passphrase/personal/${get_pulumi_outputs_stack}" \
    --with-decryption --query Parameter.Value --output text) || return 1
  PULUMI_CONFIG_PASSPHRASE="${get_pulumi_outputs_passphrase}" \
    pulumi stack output --stack "${get_pulumi_outputs_stack}" --json --show-secrets
}
