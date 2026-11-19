import { US_WEST_2_REGION } from './aws';
import { isProduction } from './dns';
import { apexRepositoryName, githubOrg } from './github';
import { runnerStateMachine } from './runner/runner';
import { runnerArtifactsBucket } from './storage';

if (isProduction) {
  // NOTE: looked up, not imported: infra/github.ts creates the provider inside its prod block
  const githubOidcProvider = aws.iam.getOpenIdConnectProviderOutput({
    url: 'https://token.actions.githubusercontent.com'
  });

  const apexGithubActionsRole = new aws.iam.Role('ApexGithubActionsRole', {
    name: 'ApexGithubActions',
    // NOTE: the build workflow waits on the runner for hours; 6h is the GitHub job ceiling
    maxSessionDuration: 6 * 60 * 60,
    assumeRolePolicy: $jsonStringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Federated: githubOidcProvider.arn },
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub': `repo:${githubOrg}/${apexRepositoryName}:ref:refs/heads/main`
            }
          }
        }
      ]
    })
  });

  new aws.iam.RolePolicy('ApexGithubActionsPolicy', {
    role: apexGithubActionsRole.id,
    policy: aws.iam.getPolicyDocumentOutput({
      statements: [
        {
          effect: 'Allow',
          actions: ['states:StartExecution'],
          resources: [runnerStateMachine.arn]
        },
        {
          effect: 'Allow',
          actions: ['states:DescribeExecution'],
          resources: [
            runnerStateMachine.arn.apply(
              (arn) => `${arn.replace(':stateMachine:', ':execution:')}:apex-*`
            )
          ]
        },
        {
          effect: 'Allow',
          actions: ['s3:ListBucket'],
          resources: [runnerArtifactsBucket.arn]
        },
        {
          effect: 'Allow',
          actions: ['s3:GetObject'],
          resources: [$interpolate`${runnerArtifactsBucket.arn}/*`]
        }
      ]
    }).json
  });

  const apexVariables = {
    AWS_ROLE_ARN: apexGithubActionsRole.arn,
    AWS_REGION: US_WEST_2_REGION,
    RUNNER_STATE_MACHINE_ARN: runnerStateMachine.arn,
    RUNNER_ARTIFACTS_BUCKET: runnerArtifactsBucket.name
  };
  for (const [variableName, value] of Object.entries(apexVariables)) {
    new github.ActionsVariable(`ApexGithub${variableName}`, {
      repository: apexRepositoryName,
      variableName,
      value
    });
  }
}
