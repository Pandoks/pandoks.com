import { STAGE_NAME } from '../dns';
import { secrets } from '../secrets';
import { runnerArtifactsBucket, runnerCacheBucket } from '../storage';
import { runnerImageArm64, runnerImageGpuArm64, runnerImageGpuX86, runnerImageX86 } from './ami';
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
function makeLaunchTemplate({
  id,
  name,
  image,
  arch,
  gpu
}: {
  id: string;
  name: string;
  image: $util.Output<string>;
  arch: 'x86_64' | 'arm64';
  gpu: boolean;
}) {
  return new aws.ec2.LaunchTemplate(id, {
    name: `${STAGE_NAME}-${name}`,
    imageId: image,
    iamInstanceProfile: { arn: runnerInstanceProfile.arn },
    tagSpecifications: [
      {
        resourceType: 'instance',
        tags: {
          ...baseTags,
          Name: `${STAGE_NAME}-${name}`,
          Arch: arch,
          ...(gpu ? { Gpu: 'nvidia' } : {})
        }
      }
    ]
  });
}

const runnerLaunchTemplateX86 = makeLaunchTemplate({
  id: 'RunnerLaunchTemplateX86',
  name: 'runner-x86',
  image: runnerImageX86.outputResources[0].amis[0].image,
  arch: 'x86_64',
  gpu: false
});
const runnerLaunchTemplateArm64 = makeLaunchTemplate({
  id: 'RunnerLaunchTemplateArm64',
  name: 'runner-arm64',
  image: runnerImageArm64.outputResources[0].amis[0].image,
  arch: 'arm64',
  gpu: false
});
const runnerLaunchTemplateGpuX86 = makeLaunchTemplate({
  id: 'RunnerLaunchTemplateGpuX86',
  name: 'runner-gpu-x86',
  image: runnerImageGpuX86.outputResources[0].amis[0].image,
  arch: 'x86_64',
  gpu: true
});
const runnerLaunchTemplateGpuArm64 = makeLaunchTemplate({
  id: 'RunnerLaunchTemplateGpuArm64',
  name: 'runner-gpu-arm64',
  image: runnerImageGpuArm64.outputResources[0].amis[0].image,
  arch: 'arm64',
  gpu: true
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
    templates: {
      x86: runnerLaunchTemplateX86.id,
      arm64: runnerLaunchTemplateArm64.id,
      gpuX86: runnerLaunchTemplateGpuX86.id,
      gpuArm64: runnerLaunchTemplateGpuArm64.id
    },
    cacheBucket: runnerCacheBucket.name,
    artifactsBucket: runnerArtifactsBucket.name,
    githubCloningTokenSSMParameter: runnerGithubTokenParameter.name
  })
});
