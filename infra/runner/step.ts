import { githubOrg, githubRepoName } from '../github';
import {
  ARM_INSTANCE_TYPES,
  GPU_ARM_INSTANCE_TYPES,
  GPU_X86_INSTANCE_TYPES,
  X86_INSTANCE_TYPES
} from './types';

const INPUT_DEFAULTS = { storageSizeGib: 8 };

const RUNNER_VARIANTS = [
  { suffix: 'X86', types: X86_INSTANCE_TYPES, templatePath: '$.templates.launchTemplateIdX86' },
  { suffix: 'Arm64', types: ARM_INSTANCE_TYPES, templatePath: '$.templates.launchTemplateIdArm64' },
  {
    suffix: 'GpuX86',
    types: GPU_X86_INSTANCE_TYPES,
    templatePath: '$.templates.launchTemplateIdGpuX86'
  },
  {
    suffix: 'GpuArm64',
    types: GPU_ARM_INSTANCE_TYPES,
    templatePath: '$.templates.launchTemplateIdGpuArm64'
  }
] as const;
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
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/sda1',
          Ebs: {
            'VolumeSize.$': '$.storageSizeGib',
            DeleteOnTermination: true
          }
        }
      ],
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

const storageSizeGate = {
  NormalizeStorageSize: {
    Type: 'Pass',
    Parameters: { 'storageSizeGibStr.$': "States.Format('{}', $.storageSizeGib)" },
    ResultPath: '$.normalized',
    Next: 'ValidateStorageSize'
  },
  ValidateStorageSize: {
    Type: 'Choice',
    Choices: [
      {
        And: [
          { Variable: '$.storageSizeGib', IsNumeric: true },
          { Variable: '$.storageSizeGib', NumericGreaterThanEquals: 8 },
          { Variable: '$.storageSizeGib', NumericLessThanEquals: 16384 },
          { Not: { Variable: '$.normalized.storageSizeGibStr', StringMatches: '*.*' } }
        ],
        Next: 'ChooseArchitecture'
      }
    ],
    Default: 'FailInvalidStorageSize'
  }
};

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
        Next: 'RunJob'
      }
    ],
    Default: 'WaitForSSM'
  }
};

const waitForJob = {
  WaitForJob: {
    Type: 'Wait',
    Seconds: 60,
    Next: 'CheckJobStatus'
  },
  CheckJobStatus: {
    Type: 'Task',
    Resource: 'arn:aws:states:::aws-sdk:ssm:getCommandInvocation',
    Parameters: {
      'CommandId.$': '$.command.Command.CommandId',
      'InstanceId.$': '$.instance.Instances[0].InstanceId'
    },
    ResultPath: '$.invocation',
    Next: 'IsJobDone',
    Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 10, MaxAttempts: 3 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'TerminateAfterFailure' }]
  },
  IsJobDone: {
    Type: 'Choice',
    Choices: [
      { Variable: '$.invocation.Status', StringEquals: 'Success', Next: 'TerminateAfterSuccess' },
      { Variable: '$.invocation.Status', StringEquals: 'Failed', Next: 'TerminateAfterFailure' },
      { Variable: '$.invocation.Status', StringEquals: 'Cancelled', Next: 'TerminateAfterFailure' },
      { Variable: '$.invocation.Status', StringEquals: 'TimedOut', Next: 'TerminateAfterFailure' }
    ],
    Default: 'WaitForJob'
  }
};

const fails = {
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
  FailInvalidStorageSize: {
    Type: 'Fail',
    Cause: 'storageSizeGib must be an integer between 8 and 16384 (gp3 max)',
    Error: 'InvalidStorageSize'
  },
  FailJob: {
    Type: 'Fail',
    Cause: 'Remote job command failed, was cancelled, or timed out',
    Error: 'JobFailed'
  }
};

export function runnerStateMachineDefinition({
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
        `export RUNNER_JOB_ID={}`,
        `export RUNNER_CACHE_BUCKET=${cacheBucket}`,
        `export RUNNER_ARTIFACTS_BUCKET=${artifactsBucket}`,
        `GITHUB_TOKEN=$(aws ssm get-parameter --name ${githubCloningTokenSSMParameter} --with-decryption --query Parameter.Value --output text)`,
        `git clone --depth 1 --branch {} https://x-access-token:$\\{GITHUB_TOKEN\\}@github.com/${githubOrg}/${githubRepoName}.git /opt/repo`,
        `unset GITHUB_TOKEN`,
        `cd /opt/repo`,
        `{}`
      ].join('; ');

      return JSON.stringify({
        Comment:
          'Ephemeral EC2 runner — launch (arch-routed), run command via SSM, always terminate',
        StartAt: 'ApplyDefaults',
        States: {
          ApplyDefaults: {
            Type: 'Pass',
            Parameters: {
              'resolved.$': `States.JsonMerge(States.StringToJson('${JSON.stringify(INPUT_DEFAULTS)}'), $$.Execution.Input, false)`
            },
            OutputPath: '$.resolved',
            Next: 'ResolveId'
          },
          ResolveId: {
            Type: 'Choice',
            Choices: [{ Variable: '$.id', IsPresent: true, Next: 'AttachTemplates' }],
            Default: 'FallbackId'
          },
          FallbackId: {
            Type: 'Pass',
            InputPath: '$$.Execution.Name',
            ResultPath: '$.id',
            Next: 'AttachTemplates'
          },
          AttachTemplates: {
            Type: 'Pass',
            Result: { launchTemplateIdX86, launchTemplateIdArm64 },
            ResultPath: '$.templates',
            Next: 'NormalizeStorageSize'
          },
          ...storageSizeGate,
          ...instanceTypesGate,
          LaunchSpotX86: launchInstance('x86', 'spot'),
          LaunchOnDemandX86: launchInstance('x86', 'on-demand'),
          LaunchSpotArm64: launchInstance('arm64', 'spot'),
          LaunchOnDemandArm64: launchInstance('arm64', 'on-demand'),
          ...waitForSsm,
          RunJob: {
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
            Next: 'WaitForJob',
            Catch: [
              { ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'TerminateAfterFailure' }
            ]
          },
          ...waitForJob,
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
            Next: 'FailJob',
            Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 15, MaxAttempts: 5 }],
            Catch: [
              { ErrorEquals: ['States.ALL'], ResultPath: '$.terminationError', Next: 'FailJob' }
            ]
          },
          ...fails,
          Done: { Type: 'Succeed' }
        }
      });
    }
  );
}
