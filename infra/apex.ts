import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as github from '@pulumi/github';
import { US_WEST_2_REGION } from './aws.ts';
import { isProduction } from './dns.ts';
import { apexRepositoryName, githubOrg } from './github.ts';
import { runnerStateMachine } from './runner/runner.ts';
import { runnerArtifactsBucket } from './storage.ts';

if (isProduction) {
  // NOTE: scripts/bootstrap.sh creates the provider
  const githubOidcProvider = aws.iam.getOpenIdConnectProviderOutput({
    url: 'https://token.actions.githubusercontent.com'
  });

  const apexGithubActionsRole = new aws.iam.Role('ApexGithubActionsRole', {
    name: 'ApexGithubActions',
    // NOTE: the build workflow waits on the runner for hours; 6h is the GitHub job ceiling
    maxSessionDuration: 6 * 60 * 60,
    assumeRolePolicy: pulumi.jsonStringify({
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
          resources: [pulumi.interpolate`${runnerArtifactsBucket.arn}/*`]
        }
      ]
    }).json
  });

  const apexVariables = {
    AWS_ROLE_ARN: apexGithubActionsRole.arn,
    AWS_REGION: US_WEST_2_REGION,
    RUNNER_STATE_MACHINE_ARN: runnerStateMachine.arn,
    RUNNER_ARTIFACTS_BUCKET: runnerArtifactsBucket.bucket
  };
  for (const [variableName, value] of Object.entries(apexVariables)) {
    new github.ActionsVariable(`ApexGithub${variableName}`, {
      repository: apexRepositoryName,
      variableName,
      value
    });
  }
}
