import { githubOrg, githubRepoName } from '../github';
import { ARM_INSTANCE_TYPES, X86_INSTANCE_TYPES } from './types';

function launchInstance(architecture: 'x86' | 'arm64', market: 'spot' | 'on-demand') {
  return {
    Type: 'Task',
    Resource: 'arn:aws:states:::aws-sdk:ec2:runInstances',
    Parameters: {
      LaunchTemplate: {
        'LaunchTemplateId.$':
          architecture === 'x86'
            ? '$.templates.launchTemplateIdX86'
            : '$.templates.launchTemplateIdArm64'
      },
      MinCount: 1,
      MaxCount: 1,
      'InstanceType.$': '$.instanceType',
      ...(market === 'spot'
        ? {
            InstanceMarketOptions: {
              MarketType: 'spot',
              SpotOptions: { SpotInstanceType: 'one-time' }
            }
          }
        : {}),
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'Id', 'Value.$': '$.id' },
            { Key: 'Ref', 'Value.$': '$.ref' }
          ]
        }
      ]
    },
    ResultPath: '$.instance',
    Next: 'WaitForSSM',
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'FailNoInstance' }]
  };
}

const instanceTypesGate = {
  ChooseArchitecture: {
    Type: 'Choice',
    Choices: [
      ...ARM_INSTANCE_TYPES.map((instanceType) => ({
        Variable: '$.instanceType',
        StringEquals: instanceType,
        Next: 'ChooseMarketArm64'
      })),
      ...X86_INSTANCE_TYPES.map((instanceType) => ({
        Variable: '$.instanceType',
        StringEquals: instanceType,
        Next: 'ChooseMarketX86'
      }))
    ],
    Default: 'FailInvalidInstanceType'
  },
  ChooseMarketX86: {
    Type: 'Choice',
    Choices: [{ Variable: '$.marketType', StringEquals: 'on-demand', Next: 'LaunchOnDemandX86' }],
    Default: 'LaunchSpotX86'
  },
  ChooseMarketArm64: {
    Type: 'Choice',
    Choices: [{ Variable: '$.marketType', StringEquals: 'on-demand', Next: 'LaunchOnDemandArm64' }],
    Default: 'LaunchSpotArm64'
  }
};

const waitForSsm = {
  WaitForSSM: {
    Type: 'Wait',
    Seconds: 60,
    Next: 'CheckSSMReady'
  },
  CheckSSMReady: {
    Type: 'Task',
    Resource: 'arn:aws:states:::aws-sdk:ssm:describeInstanceInformation',
    Parameters: {
      Filters: [
        {
          Key: 'InstanceIds',
          'Values.$': 'States.Array($.instance.Instances[0].InstanceId)'
        }
      ]
    },
    ResultPath: '$.ssmStatus',
    Next: 'IsSSMReady',
    Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 15, MaxAttempts: 8 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'TerminateAfterFailure' }]
  },
  IsSSMReady: {
    Type: 'Choice',
    Choices: [
      {
        Variable: '$.ssmStatus.InstanceInformationList[0].PingStatus',
        StringEquals: 'Online',
        Next: 'RunBuild'
      }
    ],
    Default: 'WaitForSSM'
  }
};

const waitForBuild = {
  WaitForBuild: {
    Type: 'Wait',
    Seconds: 60,
    Next: 'CheckBuildStatus'
  },
  CheckBuildStatus: {
    Type: 'Task',
    Resource: 'arn:aws:states:::aws-sdk:ssm:getCommandInvocation',
    Parameters: {
      'CommandId.$': '$.command.Command.CommandId',
      'InstanceId.$': '$.instance.Instances[0].InstanceId'
    },
    ResultPath: '$.invocation',
    Next: 'IsBuildDone',
    Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 10, MaxAttempts: 3 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'TerminateAfterFailure' }]
  },
  IsBuildDone: {
    Type: 'Choice',
    Choices: [
      { Variable: '$.invocation.Status', StringEquals: 'Success', Next: 'TerminateAfterSuccess' },
      { Variable: '$.invocation.Status', StringEquals: 'Failed', Next: 'TerminateAfterFailure' },
      { Variable: '$.invocation.Status', StringEquals: 'Cancelled', Next: 'TerminateAfterFailure' },
      { Variable: '$.invocation.Status', StringEquals: 'TimedOut', Next: 'TerminateAfterFailure' }
    ],
    Default: 'WaitForBuild'
  }
};

export function builderStateMachineDefinition({
  launchTemplateIdX86,
  launchTemplateIdArm64,
  cacheBucket,
  artifactsBucket,
  githubCloningTokenSSMParameter
}: {
  launchTemplateIdX86: $util.Input<string>;
  launchTemplateIdArm64: $util.Input<string>;
  cacheBucket: $util.Input<string>;
  artifactsBucket: $util.Input<string>;
  githubCloningTokenSSMParameter: $util.Input<string>;
}) {
  return $resolve([
    launchTemplateIdX86,
    launchTemplateIdArm64,
    cacheBucket,
    artifactsBucket,
    githubCloningTokenSSMParameter
  ]).apply(
    ([
      launchTemplateIdX86,
      launchTemplateIdArm64,
      cacheBucket,
      artifactsBucket,
      githubCloningTokenSSMParameter
    ]) => {
      const bashScript = [
        `set -euo pipefail`,
        `export BUILD_ID={}`,
        `export BUILDER_CACHE_BUCKET=${cacheBucket}`,
        `export BUILDER_ARTIFACTS_BUCKET=${artifactsBucket}`,
        `GITHUB_TOKEN=$(aws ssm get-parameter --name ${githubCloningTokenSSMParameter} --with-decryption --query Parameter.Value --output text)`,
        `git clone --depth 1 --branch {} https://x-access-token:$\\{GITHUB_TOKEN\\}@github.com/${githubOrg}/${githubRepoName}.git /opt/repo`,
        `unset GITHUB_TOKEN`,
        `cd /opt/repo`,
        `{}`
      ].join('; ');

      return JSON.stringify({
        Comment:
          'Ephemeral EC2 builder — launch (arch-routed), run script via SSM, always terminate',
        StartAt: 'ResolveInputs',
        States: {
          ResolveInputs: {
            Type: 'Choice',
            Choices: [
              { Variable: '$.id', IsPresent: true, Next: 'ResolveInputsWithId' }
            ],
            Default: 'ResolveInputsWithExecutionId'
          },
          ResolveInputsWithId: {
            Type: 'Pass',
            Parameters: {
              'id.$': '$.id',
              'ref.$': '$.ref',
              'instanceType.$': '$.instanceType',
              'marketType.$': '$.marketType',
              'command.$': '$.command',
              templates: { launchTemplateIdX86, launchTemplateIdArm64 }
            },
            Next: 'ChooseArchitecture'
          },
          ResolveInputsWithExecutionId: {
            Type: 'Pass',
            Parameters: {
              'id.$': '$$.Execution.Name',
              'ref.$': '$.ref',
              'instanceType.$': '$.instanceType',
              'marketType.$': '$.marketType',
              'command.$': '$.command',
              templates: { launchTemplateIdX86, launchTemplateIdArm64 }
            },
            Next: 'ChooseArchitecture'
          },
          ...instanceTypesGate,
          LaunchSpotX86: launchInstance('x86', 'spot'),
          LaunchOnDemandX86: launchInstance('x86', 'on-demand'),
          LaunchSpotArm64: launchInstance('arm64', 'spot'),
          LaunchOnDemandArm64: launchInstance('arm64', 'on-demand'),
          ...waitForSsm,
          RunBuild: {
            Type: 'Task',
            Resource: 'arn:aws:states:::aws-sdk:ssm:sendCommand',
            Parameters: {
              'InstanceIds.$': 'States.Array($.instance.Instances[0].InstanceId)',
              DocumentName: 'AWS-RunShellScript',
              TimeoutSeconds: 60,
              Parameters: {
                'commands.$': `States.Array(States.Format('bash -c \\'${bashScript}\\'', $.id, $.ref, $.command))`,
                executionTimeout: ['86400'] // 24 hours
              },
              CloudWatchOutputConfig: { CloudWatchOutputEnabled: true }
            },
            ResultPath: '$.command',
            Next: 'WaitForBuild',
            Catch: [
              { ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'TerminateAfterFailure' }
            ]
          },
          ...waitForBuild,
          TerminateAfterSuccess: {
            Type: 'Task',
            Resource: 'arn:aws:states:::aws-sdk:ec2:terminateInstances',
            Parameters: {
              'InstanceIds.$': 'States.Array($.instance.Instances[0].InstanceId)'
            },
            ResultPath: '$.termination',
            Next: 'Done',
            Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 15, MaxAttempts: 5 }]
          },
          TerminateAfterFailure: {
            Type: 'Task',
            Resource: 'arn:aws:states:::aws-sdk:ec2:terminateInstances',
            Parameters: {
              'InstanceIds.$': 'States.Array($.instance.Instances[0].InstanceId)'
            },
            ResultPath: '$.termination',
            Next: 'FailBuild',
            Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 15, MaxAttempts: 5 }],
            Catch: [
              { ErrorEquals: ['States.ALL'], ResultPath: '$.terminationError', Next: 'FailBuild' }
            ]
          },
          FailNoInstance: {
            Type: 'Fail',
            Cause: 'RunInstances failed; nothing to terminate',
            Error: 'LaunchFailed'
          },
          FailInvalidInstanceType: {
            Type: 'Fail',
            Cause: 'instanceType is not in the supported list',
            Error: 'InvalidInstanceType'
          },
          FailBuild: {
            Type: 'Fail',
            Cause: 'Remote build command failed, was cancelled, or timed out',
            Error: 'BuildFailed'
          },
          Done: { Type: 'Succeed' }
        }
      });
    }
  );
}
