import { awsRegion, cloudflareAccountId, isProduction, STAGE_NAME } from './dns';
import { secrets } from './secrets';
import { tailscaleAcl } from './tailscale';

export const githubRepo = await github.getRepository({
  fullName: 'Pandoks/pandoks.com'
});
const githubRepoName = githubRepo.name;

const githubEnvironment = new github.RepositoryEnvironment('GithubStageEnvironment', {
  repository: githubRepoName,
  environment: isProduction ? 'production' : 'dev'
});

new github.ActionsEnvironmentSecret('GithubHetznerApiKey', {
  repository: githubRepoName,
  environment: githubEnvironment.environment,
  secretName: 'HCLOUD_TOKEN',
  plaintextValue: secrets.hetzner.ApiKey.value
});

if ($app.stage === 'production') {
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
    value: awsRegion
  });

  new github.ActionsSecret('GithubTailscaleApiKey', {
    repository: githubRepoName,
    secretName: 'TAILSCALE_API_KEY',
    plaintextValue: secrets.tailscale.ApiKey.value
  });

  const githubActionsOauthClient = new tailscale.OauthClient(
    `${STAGE_NAME}TailscaleGithubActionsOauthClient`,
    {
      description: `${STAGE_NAME} github ci`,
      scopes: ['devices:core', 'auth_keys'],
      tags: ['tag:ci', `tag:${STAGE_NAME}`]
    },
    { dependsOn: [tailscaleAcl] }
  );
  new github.ActionsSecret('GithubActionsTailscaleOauthClientId', {
    repository: githubRepoName,
    secretName: 'TS_OAUTH_CLIENT_ID',
    plaintextValue: githubActionsOauthClient.id
  });
  new github.ActionsSecret('GithubActionsTailscaleOauthSecret', {
    repository: githubRepoName,
    secretName: 'TS_OAUTH_SECRET',
    plaintextValue: githubActionsOauthClient.key
  });
}
