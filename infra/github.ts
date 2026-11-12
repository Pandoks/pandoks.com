import { cloudflareAccountId, isProduction, STAGE_NAME } from './dns';
import { defaultAwsRegion } from './aws';
import { FIREBASE_PROJECT } from './firebase';
import { secrets } from './secrets';
import { tailscaleAcl } from './tailscale';

export const githubOrg = 'Pandoks';
export const githubRepositoryName = 'pandoks.com';

const GITHUB_ACTIONS_APP_ID = 15368;
// NOTE: AWS trusts every job in the production environment, so only main gets it.
const DEPLOYMENT_BRANCH_POLICY = isProduction
  ? { protectedBranches: false, customBranchPolicies: true }
  : undefined;

const githubEnvironment = new github.RepositoryEnvironment('GithubStageEnvironment', {
  repository: githubRepositoryName,
  environment: isProduction ? 'production' : 'dev',
  deploymentBranchPolicy: DEPLOYMENT_BRANCH_POLICY
});

new github.ActionsEnvironmentSecret('GithubHetznerApiKey', {
  repository: githubRepositoryName,
  environment: githubEnvironment.environment,
  secretName: 'HCLOUD_TOKEN',
  value: secrets.hetzner.ApiKey.value
});

if (isProduction) {
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

  new github.ActionsSecret('GithubGithubAccessToken', {
    repository: githubRepositoryName,
    secretName: 'GH_TOKEN',
    value: secrets.github.PersonalAccessToken.value
  });

  new github.ActionsSecret('GithubGithubPackageManagementToken', {
    repository: githubRepositoryName,
    secretName: 'GH_PACKAGE_MANAGEMENT_TOKEN',
    value: secrets.github.PackageManagementToken.value
  });

  new github.ActionsSecret('GithubCloudflareApiToken', {
    repository: githubRepositoryName,
    secretName: 'CLOUDFLARE_API_TOKEN',
    value: secrets.cloudflare.ApiKey.value
  });

  new github.ActionsSecret('GithubCloudflareAccountId', {
    repository: githubRepositoryName,
    secretName: 'CLOUDFLARE_DEFAULT_ACCOUNT_ID',
    value: cloudflareAccountId
  });

  new github.ActionsSecret('GithubOvhApplicationSecret', {
    repository: githubRepositoryName,
    secretName: 'OVH_APPLICATION_SECRET',
    value: secrets.ovh.ApplicationSecret.value
  });

  new github.ActionsSecret('GithubOvhConsumerKey', {
    repository: githubRepositoryName,
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
                `repo:${githubOrg}/${githubRepositoryName}:environment:production`,
                `repo:${githubOrg}/${githubRepositoryName}:ref:refs/heads/main`
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
    repository: githubRepositoryName,
    variableName: 'AWS_ROLE_ARN',
    value: githubActionsAWSRole.arn
  });
  new github.ActionsVariable('GithubAWSRegion', {
    repository: githubRepositoryName,
    variableName: 'AWS_REGION',
    value: defaultAwsRegion
  });

  // NOTE: CI needs these to deploy, so the first deploy imports them from the bootstrap in apps/push/README.md
  const githubActionsGcpPool = new gcp.iam.WorkloadIdentityPool(
    'GcpGithubActionsPool',
    { project: FIREBASE_PROJECT, workloadIdentityPoolId: 'github' },
    { import: `projects/${FIREBASE_PROJECT}/locations/global/workloadIdentityPools/github` }
  );

  const githubActionsGcpProvider = new gcp.iam.WorkloadIdentityPoolProvider(
    'GcpGithubActionsProvider',
    {
      project: FIREBASE_PROJECT,
      workloadIdentityPoolId: githubActionsGcpPool.workloadIdentityPoolId,
      workloadIdentityPoolProviderId: 'github',
      attributeMapping: { 'google.subject': 'assertion.sub' },
      attributeCondition: `assertion.sub in ['repo:${githubOrg}/${githubRepositoryName}:environment:production', 'repo:${githubOrg}/${githubRepositoryName}:ref:refs/heads/main']`,
      oidc: { issuerUri: 'https://token.actions.githubusercontent.com' }
    },
    {
      import: `projects/${FIREBASE_PROJECT}/locations/global/workloadIdentityPools/github/providers/github`
    }
  );

  const githubActionsGcpServiceAccount = new gcp.serviceaccount.Account(
    'GcpGithubActionsServiceAccount',
    { project: FIREBASE_PROJECT, accountId: 'github-actions' },
    {
      import: `projects/${FIREBASE_PROJECT}/serviceAccounts/github-actions@${FIREBASE_PROJECT}.iam.gserviceaccount.com`
    }
  );

  new gcp.projects.IAMMember('GcpGithubActionsOwner', {
    project: FIREBASE_PROJECT,
    role: 'roles/owner',
    member: githubActionsGcpServiceAccount.member
  });

  new gcp.serviceaccount.IAMMember('GcpGithubActionsWorkloadIdentityUser', {
    serviceAccountId: githubActionsGcpServiceAccount.name,
    role: 'roles/iam.workloadIdentityUser',
    member: $interpolate`principalSet://iam.googleapis.com/${githubActionsGcpPool.name}/*`
  });

  new github.ActionsVariable(
    'GithubGcpWorkloadIdentityProvider',
    {
      repository: githubRepositoryName,
      variableName: 'GCP_WORKLOAD_IDENTITY_PROVIDER',
      value: githubActionsGcpProvider.name
    },
    { import: `${githubRepositoryName}:GCP_WORKLOAD_IDENTITY_PROVIDER` }
  );
  new github.ActionsVariable(
    'GithubGcpServiceAccount',
    {
      repository: githubRepositoryName,
      variableName: 'GCP_SERVICE_ACCOUNT',
      value: githubActionsGcpServiceAccount.email
    },
    { import: `${githubRepositoryName}:GCP_SERVICE_ACCOUNT` }
  );

  new github.ActionsSecret('GithubTailscaleOauthClientId', {
    repository: githubRepositoryName,
    secretName: 'TAILSCALE_OAUTH_CLIENT_ID',
    value: secrets.tailscale.OauthClientId.value
  });
  new github.ActionsSecret('GithubTailscaleOauthClientSecret', {
    repository: githubRepositoryName,
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
    repository: githubRepositoryName,
    secretName: 'TS_OAUTH_CLIENT_ID',
    value: githubActionsOauthClient.id
  });
  new github.ActionsSecret('GithubActionsTailscaleOauthSecret', {
    repository: githubRepositoryName,
    secretName: 'TS_OAUTH_SECRET',
    value: githubActionsOauthClient.key
  });

  // NOTE: Renovate handles the security-PRs, and reads dependabot alerts.
  new github.RepositoryDependabotSecurityUpdates('GithubDependabotSecurityUpdates', {
    repository: githubRepositoryName,
    enabled: false
  });
}
