import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { awsRegion, STAGE_NAME } from '../dns';

// WARNING: version must be bumped when AMI changes to rebuild
const VERSION = '1.0.0';

const PARENT_IMAGE_ARN_X86 = `arn:aws:imagebuilder:${awsRegion}:aws:image/ubuntu-server-24-lts-x86/x.x.x`;
const PARENT_IMAGE_ARN_ARM64 = `arn:aws:imagebuilder:${awsRegion}:aws:image/ubuntu-server-24-lts-arm64/x.x.x`;

const bakeInstanceRole = new aws.iam.Role('BuilderBakeInstanceRole', {
  assumeRolePolicy: aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        effect: 'Allow',
        principals: [{ type: 'Service', identifiers: ['ec2.amazonaws.com'] }],
        actions: ['sts:AssumeRole']
      }
    ]
  }).json,
  managedPolicyArns: [
    'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
    'arn:aws:iam::aws:policy/EC2InstanceProfileForImageBuilder'
  ]
});
const bakeInstanceProfile = new aws.iam.InstanceProfile('BuilderBakeInstanceProfile', {
  role: bakeInstanceRole.name
});

