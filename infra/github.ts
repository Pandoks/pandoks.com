import type * as pulumi from '@pulumi/pulumi';
import * as github from '@pulumi/github';
import * as tailscale from '@pulumi/tailscale';
import { isProduction, isCoreStack, STAGE_NAME } from '@pandoks.com/infra/stack';
import { cloudflareAccountId } from './dns.ts';
import { secrets } from './secrets.ts';
import { tailscaleAcl } from './tailscale.ts';

export const githubOrg = 'Pandoks';
export const githubRepositoryName = 'pandoks.com';
export const outputs: Record<string, pulumi.Output<string>> = {};

const GITHUB_ACTIONS_APP_ID = 15368;
// NOTE: AWS trusts every job in the production environment, so only main gets it.
const DEPLOYMENT_BRANCH_POLICY = isProduction
  ? { protectedBranches: false, customBranchPolicies: true }
  : undefined;

let githubEnvironment: github.RepositoryEnvironment | undefined;
if (isCoreStack) {
  githubEnvironment = new github.RepositoryEnvironment('GithubStageEnvironment', {
    repository: githubRepositoryName,
    environment: isProduction ? 'production' : 'dev',
    deploymentBranchPolicy: DEPLOYMENT_BRANCH_POLICY
  });
}

if (isProduction && githubEnvironment) {
  new github.RepositoryEnvironmentDeploymentPolicy('GithubProductionDeploymentPolicy', {
    repository: githubRepositoryName,
    environment: githubEnvironment.environment,
    branchPattern: 'main'
  });

  new github.RepositoryRuleset('GithubMainRuleset', {
    name: 'main',
    repository: githubRepositoryName,
    target: 'branch',
    enforcement: 'active',
    conditions: { refName: { includes: ['refs/heads/main'], excludes: [] } },
    rules: {
      deletion: true,
      nonFastForward: true,
      pullRequest: { allowedMergeMethods: ['squash'] },
      // NOTE: No bypass: rename a required check by adding the new name, then dropping the old.
      requiredStatusChecks: {
        requiredChecks: [
          'checks-pass',
          'security-pass',
          'tests-pass',
          'build-and-publish-pass'
        ].map((context) => ({ context, integrationId: GITHUB_ACTIONS_APP_ID })),
        strictRequiredStatusChecksPolicy: true
      }
    }
  });

  // WARNING: scripts/bootstrap.sh owns AWS_ROLE_ARN and AWS_REGION, which CI needs to run this.
  new github.ActionsSecret('GithubGithubAccessToken', {
    repository: githubRepositoryName,
    secretName: 'GH_TOKEN',
    value: secrets.github.PersonalAccessToken
  });

  new github.ActionsSecret('GithubGithubPackageManagementToken', {
    repository: githubRepositoryName,
    secretName: 'GH_PACKAGE_MANAGEMENT_TOKEN',
    value: secrets.github.PackageManagementToken
  });

  new github.ActionsSecret('GithubCloudflareApiToken', {
    repository: githubRepositoryName,
    secretName: 'CLOUDFLARE_API_TOKEN',
    value: secrets.cloudflare.ApiKey
  });

  new github.ActionsSecret('GithubCloudflareAccountId', {
    repository: githubRepositoryName,
    secretName: 'CLOUDFLARE_DEFAULT_ACCOUNT_ID',
    value: cloudflareAccountId
  });

  const githubActionsOauthClient = new tailscale.OauthClient(
    `${STAGE_NAME}TailscaleGithubActionsOauthClient`,
    {
      description: `${STAGE_NAME} github ci`,
      scopes: ['devices:core', 'auth_keys'],
      tags: ['tag:ci']
    },
    { dependsOn: tailscaleAcl }
  );
  new github.ActionsSecret('GithubActionsTailscaleOauthClientId', {
    repository: githubRepositoryName,
    secretName: 'TS_OAUTH_CLIENT_ID',
    value: githubActionsOauthClient.id
  });
  new github.ActionsSecret('GithubActionsTailscaleOauthSecret', {
    repository: githubRepositoryName,
    secretName: 'TS_OAUTH_SECRET',
    value: githubActionsOauthClient.key
  });

  const githubProductionOauthClient = new tailscale.OauthClient(
    `${STAGE_NAME}TailscaleGithubProductionOauthClient`,
    {
      description: `${STAGE_NAME} github production ci`,
      scopes: ['auth_keys'],
      tags: ['tag:ci-production']
    },
    { dependsOn: tailscaleAcl }
  );
  // NOTE: deploy-infra.yaml joins with it after `pulumi up`, so a new client works in the same run.
  outputs.TailscaleProductionOauthSecret = githubProductionOauthClient.key;

  // NOTE: Renovate handles the security-PRs, and reads dependabot alerts.
  new github.RepositoryDependabotSecurityUpdates('GithubDependabotSecurityUpdates', {
    repository: githubRepositoryName,
    enabled: false
  });
}
