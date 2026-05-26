import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { awsRegion } from '../dns';

// WARNING: version must be bumped when AMI changes to rebuild
const VERSION = '1.0.0';

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

const builderToolsComponent = new aws.imagebuilder.Component('BuilderToolsComponent', {
  name: `builder-tools`,
  platform: 'Linux',
  version: VERSION,
  data: readFileSync(join(process.cwd(), 'infra/builder/ami.yaml'), 'utf-8')
});
const builderRecipeX86 = new aws.imagebuilder.ImageRecipe('BuilderRecipeX86', {
  name: `builder-x86`,
  parentImage: `arn:aws:imagebuilder:${awsRegion}:aws:image/ubuntu-server-24-lts-x86/x.x.x`,
  version: VERSION,
  components: [{ componentArn: builderToolsComponent.arn }]
});
const builderRecipeArm64 = new aws.imagebuilder.ImageRecipe('BuilderRecipeArm64', {
  name: `builder-arm64`,
  parentImage: `arn:aws:imagebuilder:${awsRegion}:aws:image/ubuntu-server-24-lts-arm64/x.x.x`,
  version: VERSION,
  components: [{ componentArn: builderToolsComponent.arn }]
});

const builderBakeInfraX86 = new aws.imagebuilder.InfrastructureConfiguration(
  'BuilderBakeInfraX86',
  {
    name: `builder-bake-x86`,
    instanceTypes: ['c7i.large'],
    instanceProfileName: bakeInstanceProfile.name,
    terminateInstanceOnFailure: true
  }
);
const builderBakeInfraArm64 = new aws.imagebuilder.InfrastructureConfiguration(
  'BuilderBakeInfraArm64',
  {
    name: `builder-bake-arm64`,
    instanceTypes: ['c7g.large'],
    instanceProfileName: bakeInstanceProfile.name,
    terminateInstanceOnFailure: true
  }
);

export const builderImageX86 = new aws.imagebuilder.Image('BuilderImageX86', {
  imageRecipeArn: builderRecipeX86.arn,
  infrastructureConfigurationArn: builderBakeInfraX86.arn
});
export const builderImageArm64 = new aws.imagebuilder.Image('BuilderImageArm64', {
  imageRecipeArn: builderRecipeArm64.arn,
  infrastructureConfigurationArn: builderBakeInfraArm64.arn
});

const lifecycleRole = new aws.iam.Role('BuilderLifecycleRole', {
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
new aws.imagebuilder.LifecyclePolicy('BuilderLifecyclePolicy', {
  name: `builder-image-lifecycle`,
  description:
    'Keep the latest 10 builder AMI versions per arch; delete older versions and their snapshots',
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
        value: 10,
        retainAtLeast: 1
      }
    }
  ],
  resourceSelection: {
    recipes: [
      { name: builderRecipeX86.name, semanticVersion: VERSION },
      { name: builderRecipeArm64.name, semanticVersion: VERSION }
    ]
  }
});
