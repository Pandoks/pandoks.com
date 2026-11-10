import { cloudflareAccountId, isProduction, STAGE_NAME } from './dns';
import { defaultAwsRegion } from './aws';
import { secrets } from './secrets';
import { tailscaleAcl } from './tailscale';

export const githubOrg = 'Pandoks';
export const githubRepoName = 'pandoks.com';

const GITHUB_ACTIONS_APP_ID = 15368;
// NOTE: AWS trusts every job in the production environment, so only main gets it.
const DEPLOYMENT_BRANCH_POLICY = isProduction
  ? { protectedBranches: false, customBranchPolicies: true }
  : undefined;

const githubEnvironment = new github.RepositoryEnvironment('GithubStageEnvironment', {
  repository: githubRepoName,
  environment: isProduction ? 'production' : 'dev',
  deploymentBranchPolicy: DEPLOYMENT_BRANCH_POLICY
});

new github.ActionsEnvironmentSecret('GithubHetznerApiKey', {
  repository: githubRepoName,
  environment: githubEnvironment.environment,
  secretName: 'HCLOUD_TOKEN',
  value: secrets.hetzner.ApiKey.value
});

if (isProduction) {
  new github.RepositoryEnvironmentDeploymentPolicy('GithubProductionDeploymentPolicy', {
    repository: githubRepoName,
    environment: githubEnvironment.environment,
    branchPattern: 'main'
  });

  new github.RepositoryRuleset('GithubMainRuleset', {
    name: 'main',
    repository: githubRepoName,
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

  new github.ActionsSecret('GithubGithubAccessToken', {
    repository: githubRepoName,
    secretName: 'GH_TOKEN',
    value: secrets.github.PersonalAccessToken.value
  });

  new github.ActionsSecret('GithubGithubPackageManagementToken', {
    repository: githubRepoName,
    secretName: 'GH_PACKAGE_MANAGEMENT_TOKEN',
    value: secrets.github.PackageManagementToken.value
  });

  new github.ActionsSecret('GithubCloudflareApiToken', {
    repository: githubRepoName,
    secretName: 'CLOUDFLARE_API_TOKEN',
    value: secrets.cloudflare.ApiKey.value
  });

  new github.ActionsSecret('GithubCloudflareAccountId', {
    repository: githubRepoName,
    secretName: 'CLOUDFLARE_DEFAULT_ACCOUNT_ID',
    value: cloudflareAccountId
  });

  new github.ActionsSecret('GithubOvhApplicationSecret', {
    repository: githubRepoName,
    secretName: 'OVH_APPLICATION_SECRET',
    value: secrets.ovh.ApplicationSecret.value
  });

  new github.ActionsSecret('GithubOvhConsumerKey', {
    repository: githubRepoName,
    secretName: 'OVH_CONSUMER_KEY',
    value: secrets.ovh.ConsumerKey.value
  });

  const githubAWSOidcProvider = new aws.iam.OpenIdConnectProvider('AWSGithubActionsOidc', {
    url: 'https://token.actions.githubusercontent.com',
    clientIdLists: ['sts.amazonaws.com']
  });

  const githubActionsAWSRole = new aws.iam.Role('AWSGithubActionsRole', {
    name: 'PersonalGithubActions',
    assumeRolePolicy: $jsonStringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
            Federated: githubAWSOidcProvider.arn
          },
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub': [
                `repo:${githubOrg}/${githubRepoName}:environment:production`,
                `repo:${githubOrg}/${githubRepoName}:ref:refs/heads/main`
              ]
            }
          }
        }
      ]
    })
  });

  new aws.iam.RolePolicyAttachment('AWSGithubActionsPolicy', {
    role: githubActionsAWSRole.name,
    policyArn: aws.iam.ManagedPolicy.AdministratorAccess
  });

  new github.ActionsVariable('GithubAWSRole', {
    repository: githubRepoName,
    variableName: 'AWS_ROLE_ARN',
    value: githubActionsAWSRole.arn
  });
  new github.ActionsVariable('GithubAWSRegion', {
    repository: githubRepoName,
    variableName: 'AWS_REGION',
    value: defaultAwsRegion
  });

  new github.ActionsSecret('GithubTailscaleOauthClientId', {
    repository: githubRepoName,
    secretName: 'TAILSCALE_OAUTH_CLIENT_ID',
    value: secrets.tailscale.OauthClientId.value
  });
  new github.ActionsSecret('GithubTailscaleOauthClientSecret', {
    repository: githubRepoName,
    secretName: 'TAILSCALE_OAUTH_CLIENT_SECRET',
    value: secrets.tailscale.OauthClientSecret.value
  });

  const githubActionsOauthClient = new tailscale.OauthClient(
    `${STAGE_NAME}TailscaleGithubActionsOauthClient`,
    {
      description: `${STAGE_NAME} github ci`,
      scopes: ['devices:core', 'auth_keys'],
      tags: ['tag:ci']
    },
    { dependsOn: [tailscaleAcl] }
  );
  new github.ActionsSecret('GithubActionsTailscaleOauthClientId', {
    repository: githubRepoName,
    secretName: 'TS_OAUTH_CLIENT_ID',
    value: githubActionsOauthClient.id
  });
  new github.ActionsSecret('GithubActionsTailscaleOauthSecret', {
    repository: githubRepoName,
    secretName: 'TS_OAUTH_SECRET',
    value: githubActionsOauthClient.key
  });

  // NOTE: Renovate handles the security-PRs, and reads dependabot alerts.
  new github.RepositoryDependabotSecurityUpdates('GithubDependabotSecurityUpdates', {
    repository: githubRepoName,
    enabled: false
  });
}
