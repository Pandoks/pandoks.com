import { cloudflareAccountId, isProduction, isDev } from './dns';
import { defaultAwsRegion } from './aws';
import { secrets } from './secrets';

export const githubOrg = 'Pandoks';
export const githubRepoName = 'pandoks.com';

const githubEnvironment = new github.RepositoryEnvironment('GithubStageEnvironment', {
  repository: githubRepoName,
  environment: isProduction ? 'production' : isDev ? 'preview' : 'dev'
});

new github.ActionsEnvironmentSecret('GithubHetznerApiKey', {
  repository: githubRepoName,
  environment: githubEnvironment.environment,
  secretName: 'HCLOUD_TOKEN',
  plaintextValue: secrets.hetzner.ApiKey.value
});

if (isProduction) {
  const githubChecksEnvironment = new github.RepositoryEnvironment('GithubChecksEnvironment', {
    repository: githubRepoName,
    environment: 'checks'
  });
  new github.ActionsEnvironmentSecret('GithubChecksHetznerApiKey', {
    repository: githubRepoName,
    environment: githubChecksEnvironment.environment,
    secretName: 'HCLOUD_TOKEN',
    plaintextValue: secrets.hetzner.ApiKey.value
  });

  new github.BranchProtection('GithubMainBranchProtection', {
    repositoryId: githubRepoName,
    pattern: 'main',
    requiredStatusChecks: [
      {
        strict: false,
        contexts: ['checks-pass', 'security-pass', 'tests-pass', 'build-and-publish-pass']
      }
    ],
    allowsDeletions: false,
    allowsForcePushes: false,
    enforceAdmins: false
  });

  new github.ActionsSecret('GithubGithubAccessToken', {
    repository: githubRepoName,
    secretName: 'GH_TOKEN',
    plaintextValue: secrets.github.PersonalAccessToken.value
  });

  new github.ActionsSecret('GithubCloudflareApiToken', {
    repository: githubRepoName,
    secretName: 'CLOUDFLARE_API_TOKEN',
    plaintextValue: secrets.cloudflare.ApiKey.value
  });

  new github.ActionsSecret('GithubCloudflareAccountId', {
    repository: githubRepoName,
    secretName: 'CLOUDFLARE_DEFAULT_ACCOUNT_ID',
    plaintextValue: cloudflareAccountId
  });

  new github.ActionsSecret('GithubOvhApplicationSecret', {
    repository: githubRepoName,
    secretName: 'OVH_APPLICATION_SECRET',
    plaintextValue: secrets.ovh.ApplicationSecret.value
  });

  new github.ActionsSecret('GithubOvhConsumerKey', {
    repository: githubRepoName,
    secretName: 'OVH_CONSUMER_KEY',
    plaintextValue: secrets.ovh.ConsumerKey.value
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
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com'
            },
            StringLike: {
              'token.actions.githubusercontent.com:sub': 'repo:Pandoks/*'
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
    plaintextValue: secrets.tailscale.OauthClientId.value
  });
  new github.ActionsSecret('GithubTailscaleOauthClientSecret', {
    repository: githubRepoName,
    secretName: 'TAILSCALE_OAUTH_CLIENT_SECRET',
    plaintextValue: secrets.tailscale.OauthClientSecret.value
  });

  // NOTE: Renovate handles the security-PRs, and reads dependabot alerts.
  new github.RepositoryDependabotSecurityUpdates('GithubDependabotSecurityUpdates', {
    repository: githubRepoName,
    enabled: false
  });
}
