import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { awsRegion, STAGE_NAME } from '../dns';

// WARNING: version must be bumped when AMI changes to rebuild
const VERSION = '1.0.0';

const bakeInstanceRole = new aws.iam.Role('RunnerBakeInstanceRole', {
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
const bakeInstanceProfile = new aws.iam.InstanceProfile('RunnerBakeInstanceProfile', {
  role: bakeInstanceRole.name
});

const runnerToolsComponent = new aws.imagebuilder.Component('RunnerToolsComponent', {
  name: `${STAGE_NAME}-runner-tools`,
  platform: 'Linux',
  version: VERSION,
  data: readFileSync(join(process.cwd(), 'infra/runner/ami.yaml'), 'utf-8')
});
const runnerRecipeX86 = new aws.imagebuilder.ImageRecipe('RunnerRecipeX86', {
  name: `${STAGE_NAME}-runner-x86`,
  parentImage: `arn:aws:imagebuilder:${awsRegion}:aws:image/ubuntu-server-24-lts-x86/x.x.x`,
  version: VERSION,
  components: [{ componentArn: runnerToolsComponent.arn }]
});
const runnerRecipeArm64 = new aws.imagebuilder.ImageRecipe('RunnerRecipeArm64', {
  name: `${STAGE_NAME}-runner-arm64`,
  parentImage: `arn:aws:imagebuilder:${awsRegion}:aws:image/ubuntu-server-24-lts-arm64/x.x.x`,
  version: VERSION,
  components: [{ componentArn: runnerToolsComponent.arn }]
});

const runnerBakeInfraX86 = new aws.imagebuilder.InfrastructureConfiguration('RunnerBakeInfraX86', {
  name: `${STAGE_NAME}-runner-bake-x86`,
  instanceTypes: ['c7i.large'],
  instanceProfileName: bakeInstanceProfile.name,
  terminateInstanceOnFailure: true
});
const runnerBakeInfraArm64 = new aws.imagebuilder.InfrastructureConfiguration(
  'RunnerBakeInfraArm64',
  {
    name: `${STAGE_NAME}-runner-bake-arm64`,
    instanceTypes: ['c7g.large'],
    instanceProfileName: bakeInstanceProfile.name,
    terminateInstanceOnFailure: true
  }
);

export const runnerImageX86 = new aws.imagebuilder.Image('RunnerImageX86', {
  imageRecipeArn: runnerRecipeX86.arn,
  infrastructureConfigurationArn: runnerBakeInfraX86.arn
});
export const runnerImageArm64 = new aws.imagebuilder.Image('RunnerImageArm64', {
  imageRecipeArn: runnerRecipeArm64.arn,
  infrastructureConfigurationArn: runnerBakeInfraArm64.arn
});

const lifecycleRole = new aws.iam.Role('RunnerLifecycleRole', {
  assumeRolePolicy: aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        effect: 'Allow',
        principals: [{ type: 'Service', identifiers: ['imagebuilder.amazonaws.com'] }],
        actions: ['sts:AssumeRole']
      }
    ]
  }).json,
  managedPolicyArns: [
    'arn:aws:iam::aws:policy/service-role/EC2ImageBuilderLifecycleExecutionPolicy'
  ]
});
new aws.imagebuilder.LifecyclePolicy('RunnerLifecyclePolicy', {
  name: `${STAGE_NAME}-runner-image-lifecycle`,
  description:
    'Keep the latest 10 runner AMI versions per arch; delete older versions and their snapshots',
  executionRole: lifecycleRole.arn,
  resourceType: 'AMI_IMAGE',
  policyDetails: [
    {
      action: {
        type: 'DELETE',
        includeResources: { amis: true, snapshots: true }
      },
      filter: {
        type: 'COUNT',
        value: 10
      }
    }
  ],
  resourceSelection: {
    recipes: [
      { name: runnerRecipeX86.name, semanticVersion: VERSION },
      { name: runnerRecipeArm64.name, semanticVersion: VERSION }
    ]
  }
});
