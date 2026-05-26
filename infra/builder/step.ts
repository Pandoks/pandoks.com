export const ARM_INSTANCE_TYPES = ['c7g.16xlarge', 'c8g.16xlarge', 'c8g.48xlarge'] as const;
export const X86_INSTANCE_TYPES = [
  'c7i.16xlarge',
  'c7i.24xlarge',
  'c8i.24xlarge',
  'c7i.metal-48xl',
  'm8i.24xlarge',
  'c7i.48xlarge',
  'c8a.48xlarge',
  'c8i.48xlarge',
  'c8i.metal-48xl'
] as const;

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
            { Key: 'BuildId', 'Value.$': '$.buildId' },
            { Key: 'Script', 'Value.$': '$.script' },
            { Key: 'RepoRef', 'Value.$': '$.repoRef' }
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
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'Terminate' }]
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
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'Terminate' }]
  },
  IsBuildDone: {
    Type: 'Choice',
    Choices: [
      { Variable: '$.invocation.Status', StringEquals: 'Success', Next: 'Terminate' },
      { Variable: '$.invocation.Status', StringEquals: 'Failed', Next: 'Terminate' },
      { Variable: '$.invocation.Status', StringEquals: 'Cancelled', Next: 'Terminate' },
      { Variable: '$.invocation.Status', StringEquals: 'TimedOut', Next: 'Terminate' }
    ],
    Default: 'WaitForBuild'
  }
};

export function builderStateMachineDefinition(
  launchTemplateIdX86: $util.Input<string>,
  launchTemplateIdArm64: $util.Input<string>,
  cacheBucket: $util.Input<string>,
  artifactsBucket: $util.Input<string>
) {
  return $resolve([launchTemplateIdX86, launchTemplateIdArm64, cacheBucket, artifactsBucket]).apply(
    ([launchTemplateIdX86, launchTemplateIdArm64, cacheBucket, artifactsBucket]) =>
      JSON.stringify({
        Comment:
          'Ephemeral EC2 builder — launch (arch-routed), run script via SSM, always terminate',
        StartAt: 'ResolveLaunchTemplates',
        States: {
          ResolveLaunchTemplates: {
            Type: 'Pass',
            Result: {
              launchTemplateIdX86,
              launchTemplateIdArm64
            },
            ResultPath: '$.templates',
            Next: 'ChooseArchitecture'
          },
          ...instanceTypesGate,
          LaunchSpotX86: launchInstance('x86', 'spot'),
          LaunchOnDemandX86: launchInstance('x86', 'on-demand'),
          LaunchSpotArm64: launchInstance('arm64', 'spot'),
          LaunchOnDemandArm64: launchInstance('arm64', 'on-demand'),
          ...waitForSsm,
            Type: 'Wait',
            Seconds: 60,
            Next: 'CheckSSMReady'
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
          Done: { Type: 'Succeed' }
        }
      })
  );
}
