import { STAGE_NAME } from '../dns';
import { secrets } from '../secrets';
import { runnerArtifactsBucket, runnerCacheBucket } from '../storage';
import { runnerImageArm64, runnerImageX86 } from './ami';
import { runnerStateMachineDefinition } from './step';

const runnerInstanceRole = new aws.iam.Role('RunnerInstanceRole', {
  assumeRolePolicy: aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        effect: 'Allow',
        principals: [{ type: 'Service', identifiers: ['ec2.amazonaws.com'] }],
        actions: ['sts:AssumeRole']
      }
    ]
  }).json,
  managedPolicyArns: ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore']
});
new aws.iam.RolePolicy('RunnerInstanceS3Policy', {
  role: runnerInstanceRole.id,
  policy: aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        effect: 'Allow',
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
        resources: [
          runnerCacheBucket.arn,
          $interpolate`${runnerCacheBucket.arn}/*`,
          runnerArtifactsBucket.arn,
          $interpolate`${runnerArtifactsBucket.arn}/*`
        ]
      }
    ]
  }).json
});
const runnerInstanceProfile = new aws.iam.InstanceProfile('RunnerInstanceProfile', {
  role: runnerInstanceRole.name
});

const baseTags = { Stage: STAGE_NAME, ManagedBy: 'Runner' };
const runnerLaunchTemplateX86 = new aws.ec2.LaunchTemplate('RunnerLaunchTemplateX86', {
  name: `${STAGE_NAME}-runner-x86`,
  imageId: runnerImageX86.outputResources[0].amis[0].image,
  iamInstanceProfile: { arn: runnerInstanceProfile.arn },
  tagSpecifications: [
    {
      resourceType: 'instance',
      tags: { ...baseTags, Name: `${STAGE_NAME}-runner-x86`, Arch: 'x86_64' }
    }
  ]
});
const runnerLaunchTemplateArm64 = new aws.ec2.LaunchTemplate('RunnerLaunchTemplateArm64', {
  name: `${STAGE_NAME}-runner-arm64`,
  imageId: runnerImageArm64.outputResources[0].amis[0].image,
  iamInstanceProfile: { arn: runnerInstanceProfile.arn },
  tagSpecifications: [
    {
      resourceType: 'instance',
      tags: { ...baseTags, Name: `${STAGE_NAME}-runner-arm64`, Arch: 'arm64' }
    }
  ]
});

export const runnerGithubTokenParameter = new aws.ssm.Parameter('RunnerGithubCloningToken', {
  name: `/runners/${STAGE_NAME}/github-cloning-pat`,
  type: 'SecureString',
  value: secrets.github.PersonalAccessToken.value
});

const runnerStateMachineRole = new aws.iam.Role('RunnerStateMachineRole', {
  assumeRolePolicy: aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        effect: 'Allow',
        principals: [{ type: 'Service', identifiers: ['states.amazonaws.com'] }],
        actions: ['sts:AssumeRole']
      }
    ]
  }).json
});
new aws.iam.RolePolicy('RunnerStateMachinePolicy', {
  role: runnerStateMachineRole.id,
  policy: aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        effect: 'Allow',
        actions: [
          'ec2:RunInstances',
          'ec2:TerminateInstances',
          'ec2:DescribeInstances',
          'ec2:CreateTags'
        ],
        resources: ['*']
      },
      {
        effect: 'Allow',
        actions: ['ssm:SendCommand', 'ssm:GetCommandInvocation', 'ssm:DescribeInstanceInformation'],
        resources: ['*']
      },
      {
        effect: 'Allow',
        actions: ['iam:PassRole'],
        resources: [runnerInstanceRole.arn]
      }
    ]
  }).json
});

export const runnerStateMachine = new aws.sfn.StateMachine('RunnerStateMachine', {
  name: `${STAGE_NAME}-runner`,
  roleArn: runnerStateMachineRole.arn,
  type: 'STANDARD',
  definition: runnerStateMachineDefinition({
    launchTemplateIdX86: runnerLaunchTemplateX86.id,
    launchTemplateIdArm64: runnerLaunchTemplateArm64.id,
    cacheBucket: runnerCacheBucket.name,
    artifactsBucket: runnerArtifactsBucket.name,
    githubCloningTokenSSMParameter: runnerGithubTokenParameter.name
  })
});
