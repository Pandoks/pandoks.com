import { awsRegion, cloudflareAccountId, isProduction } from './dns';
import { secrets } from './secrets';

export const githubRepo = github.getRepository({
  fullName: 'pandoks/pandoks.com'
});

const githubEnvironment = new github.RepositoryEnvironment('GithubStageEnvironment', {
  repository: githubRepo.then((r) => r.name),
  environment: isProduction ? 'production' : 'dev'
});

new github.ActionsEnvironmentSecret('GithubHetznerApiKey', {
  repository: githubRepo.then((r) => r.name),
  environment: githubEnvironment.environment,
  secretName: 'HCLOUD_TOKEN',
  plaintextValue: secrets.hetzner.ApiKey.value
});

if ($app.stage === 'production') {
  new github.ActionsSecret('GithubCloudflareApiToken', {
    repository: githubRepo.then((r) => r.name),
    secretName: 'CLOUDFLARE_API_TOKEN',
    plaintextValue: secrets.cloudflare.ApiKey.value
  });

  new github.ActionsSecret('GithubCloudflareAccountId', {
    repository: githubRepo.then((r) => r.name),
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
    repository: githubRepo.then((r) => r.name),
    variableName: 'AWS_ROLE_ARN',
    value: githubActionsAWSRole.arn
  });
  new github.ActionsVariable('GithubAWSRegion', {
    repository: githubRepo.then((r) => r.name),
    variableName: 'AWS_REGION',
    value: awsRegion
  });

  new github.ActionsSecret('GithubTailscaleApiKey', {
    repository: githubRepo.then((r) => r.name),
    secretName: 'TAILSCALE_API_KEY',
    plaintextValue: secrets.tailscale.ApiKey.value
  });
}
