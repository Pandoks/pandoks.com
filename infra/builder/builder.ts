import { builderArtifactsBucket, builderCacheBucket } from '../storage';

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
