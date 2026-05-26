import { STAGE_NAME } from '../dns';
import { secrets } from '../secrets';
import { builderArtifactsBucket, builderCacheBucket } from '../storage';
import { builderImageArm64, builderImageX86 } from './ami';

const builderInstanceRole = new aws.iam.Role('BuilderInstanceRole', {
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
new aws.iam.RolePolicy('BuilderInstanceS3Policy', {
  role: builderInstanceRole.id,
  policy: aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        effect: 'Allow',
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
        resources: [
          builderCacheBucket.arn,
          $interpolate`${builderCacheBucket.arn}/*`,
          builderArtifactsBucket.arn,
          $interpolate`${builderArtifactsBucket.arn}/*`
        ]
      }
    ]
  }).json
});
const builderInstanceProfile = new aws.iam.InstanceProfile('BuilderInstanceProfile', {
  role: builderInstanceRole.name
});

const baseTags = { Stage: STAGE_NAME, ManagedBy: 'Builder' };
const builderLaunchTemplateX86 = new aws.ec2.LaunchTemplate('BuilderLaunchTemplateX86', {
  name: `builder-x86`,
  imageId: builderImageX86.id,
  iamInstanceProfile: { arn: builderInstanceProfile.arn },
  tagSpecifications: [
    {
      resourceType: 'instance',
      tags: { ...baseTags, Name: `builder-x86`, Arch: 'x86_64' }
    }
  ]
});
const builderLaunchTemplateArm64 = new aws.ec2.LaunchTemplate('BuilderLaunchTemplateArm64', {
  name: `builder-arm64`,
  imageId: builderImageArm64.id,
  iamInstanceProfile: { arn: builderInstanceProfile.arn },
  tagSpecifications: [
    {
      resourceType: 'instance',
      tags: { ...baseTags, Name: `builder-arm64`, Arch: 'arm64' }
    }
  ]
});

export const builderGithubTokenParam = new aws.ssm.Parameter('BuilderGithubCloningToken', {
  name: '/builders/github-cloning-pat',
  type: 'SecureString',
  value: secrets.github.PersonalAccessToken.value
});
const builderStateMachineRole = new aws.iam.Role('BuilderStateMachineRole', {
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
new aws.iam.RolePolicy('BuilderStateMachinePolicy', {
  role: builderStateMachineRole.id,
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
        resources: [builderInstanceRole.arn]
      }
    ]
  }).json
});
