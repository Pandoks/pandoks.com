import * as github from '@pulumi/github';
import * as tailscale from '@pulumi/tailscale';
import { cloudflareAccountId, isProduction, STAGE_NAME } from './dns.ts';
import { providers, secrets } from './secrets.ts';
import { tailscaleAcl } from './tailscale.ts';

export const githubOrg = 'Pandoks';
export const githubRepositoryName = 'pandoks.com';

const GITHUB_ACTIONS_APP_ID = 15368;
// NOTE: AWS trusts every job in the production environment, so only main gets it.
const DEPLOYMENT_BRANCH_POLICY = isProduction
  ? { protectedBranches: false, customBranchPolicies: true }
  : undefined;

const githubEnvironment = new github.RepositoryEnvironment(
  'GithubStageEnvironment',
  {
    repository: githubRepositoryName,
    environment: isProduction ? 'production' : 'dev',
    deploymentBranchPolicy: DEPLOYMENT_BRANCH_POLICY
  },
  { provider: providers.github }
);

if (isProduction) {
  new github.RepositoryEnvironmentDeploymentPolicy(
    'GithubProductionDeploymentPolicy',
    {
      repository: githubRepositoryName,
      environment: githubEnvironment.environment,
      branchPattern: 'main'
    },
    { provider: providers.github }
  );

  new github.RepositoryRuleset(
    'GithubMainRuleset',
    {
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
    },
    { provider: providers.github }
  );

  new github.ActionsSecret(
    'GithubGithubAccessToken',
    {
      repository: githubRepositoryName,
      secretName: 'GH_TOKEN',
      value: secrets.github.PersonalAccessToken
    },
    { provider: providers.github }
  );

  new github.ActionsSecret(
    'GithubGithubPackageManagementToken',
    {
      repository: githubRepositoryName,
      secretName: 'GH_PACKAGE_MANAGEMENT_TOKEN',
      value: secrets.github.PackageManagementToken
    },
    { provider: providers.github }
  );

  new github.ActionsSecret(
    'GithubCloudflareApiToken',
    {
      repository: githubRepositoryName,
      secretName: 'CLOUDFLARE_API_TOKEN',
      value: secrets.cloudflare.ApiKey
    },
    { provider: providers.github }
  );

  new github.ActionsSecret(
    'GithubCloudflareAccountId',
    {
      repository: githubRepositoryName,
      secretName: 'CLOUDFLARE_DEFAULT_ACCOUNT_ID',
      value: cloudflareAccountId
    },
    { provider: providers.github }
  );

  const githubActionsOauthClient = new tailscale.OauthClient(
    `${STAGE_NAME}TailscaleGithubActionsOauthClient`,
    {
      description: `${STAGE_NAME} github ci`,
      scopes: ['devices:core', 'auth_keys'],
      tags: ['tag:ci']
    },
    { provider: providers.tailscale, dependsOn: [tailscaleAcl] }
  );
  new github.ActionsSecret(
    'GithubActionsTailscaleOauthClientId',
    {
      repository: githubRepositoryName,
      secretName: 'TS_OAUTH_CLIENT_ID',
      value: githubActionsOauthClient.id
    },
    { provider: providers.github }
  );
  new github.ActionsSecret(
    'GithubActionsTailscaleOauthSecret',
    {
      repository: githubRepositoryName,
      secretName: 'TS_OAUTH_SECRET',
      value: githubActionsOauthClient.key
    },
    { provider: providers.github }
  );

  // NOTE: Renovate handles the security-PRs, and reads dependabot alerts.
  new github.RepositoryDependabotSecurityUpdates(
    'GithubDependabotSecurityUpdates',
    {
      repository: githubRepositoryName,
      enabled: false
    },
    { provider: providers.github }
  );
}
