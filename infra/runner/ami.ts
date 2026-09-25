import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { US_WEST_2_REGION, usWest2Provider } from '../aws';
import { STAGE_NAME } from '../dns';

// Bump when the recipes in this file change (parent images, volumes, component lists). Component
// contents are versioned automatically below; bump this too if a component reverts to an old state.
const RECIPE_VERSION = '1.1';

const bakeInstanceRole = new aws.iam.Role(
  'RunnerBakeInstanceRole',
  {
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
  },
  { provider: usWest2Provider }
);
const bakeInstanceProfile = new aws.iam.InstanceProfile(
  'RunnerBakeInstanceProfile',
  {
    role: bakeInstanceRole.name
  },
  { provider: usWest2Provider }
);

function renderAmiTemplateYaml({
  file,
  replacements
}: {
  file: string;
  replacements?: Record<string, string>;
}) {
  let data = readFileSync(join(process.cwd(), 'infra/runner', file), 'utf-8');
  if (replacements) {
    for (const [token, value] of Object.entries(replacements)) {
      data = data.replaceAll(`{{${token}}}`, value);
    }
  }
  return data;
}

const runnerToolsData = renderAmiTemplateYaml({ file: 'ami.yaml' });
const runnerGpuX86ToolsData = renderAmiTemplateYaml({
  file: 'ami-gpu.yaml',
  replacements: { CUDA_ARCH: 'x86_64' }
});
const runnerGpuArmToolsData = renderAmiTemplateYaml({
  file: 'ami-gpu.yaml',
  replacements: { CUDA_ARCH: 'sbsa' }
});

// Image Builder versions are immutable, so the patch number follows the component contents: a
// Renovate bump in ami.yaml rebakes the AMIs without a hand-edited version. 7 hex digits stay under
// Image Builder's 2^30 - 1 limit per version node.
const componentsHash = createHash('sha256')
  .update([runnerToolsData, runnerGpuX86ToolsData, runnerGpuArmToolsData].join('\0'))
  .digest('hex');
const VERSION = `${RECIPE_VERSION}.${parseInt(componentsHash.slice(0, 7), 16)}`;

const ARCH_IMAGE_MAPPING = {
  x86: `arn:aws:imagebuilder:${US_WEST_2_REGION}:aws:image/ubuntu-server-24-lts-x86/x.x.x`,
  arm64: `arn:aws:imagebuilder:${US_WEST_2_REGION}:aws:image/ubuntu-server-24-lts-arm64/x.x.x`
} as const;
function makeRecipe({
  id,
  name,
  arch,
  components,
  volumeSizeGib
}: {
  id: string;
  name: string;
  arch: keyof typeof ARCH_IMAGE_MAPPING;
  components: aws.imagebuilder.Component[];
  volumeSizeGib?: number;
}) {
  return new aws.imagebuilder.ImageRecipe(
    id,
    {
      name: `${STAGE_NAME}-${name}`,
      parentImage: ARCH_IMAGE_MAPPING[arch],
      version: VERSION,
      components: components.map((c) => ({ componentArn: c.arn })),
      blockDeviceMappings: volumeSizeGib // NOTE: default 8 GiB can't hold the full CUDA toolkit for GPU
        ? [
            {
              deviceName: '/dev/sda1',
              ebs: { volumeSize: volumeSizeGib, volumeType: 'gp3', deleteOnTermination: 'true' }
            }
          ]
        : undefined
    },
    { provider: usWest2Provider }
  );
}

function makeBakeInfra({
  id,
  name,
  instanceType
}: {
  id: string;
  name: string;
  instanceType: string;
}) {
  return new aws.imagebuilder.InfrastructureConfiguration(
    id,
    {
      name: `${STAGE_NAME}-${name}`,
      instanceTypes: [instanceType],
      instanceProfileName: bakeInstanceProfile.name,
      terminateInstanceOnFailure: true
    },
    { provider: usWest2Provider }
  );
}

const runnerToolsComponent = new aws.imagebuilder.Component(
  'RunnerToolsComponent',
  {
    name: `${STAGE_NAME}-runner-tools`,
    platform: 'Linux',
    version: VERSION,
    skipDestroy: true,
    data: runnerToolsData
  },
  { provider: usWest2Provider }
);
const runnerGpuX86ToolsComponent = new aws.imagebuilder.Component(
  'RunnerGpuToolsComponent',
  {
    name: `${STAGE_NAME}-runner-gpu-tools`,
    platform: 'Linux',
    version: VERSION,
    skipDestroy: true,
    data: runnerGpuX86ToolsData
  },
  { provider: usWest2Provider }
);
const runnerGpuArmToolsComponent = new aws.imagebuilder.Component(
  'RunnerGpuArmToolsComponent',
  {
    name: `${STAGE_NAME}-runner-gpu-arm-tools`,
    platform: 'Linux',
    version: VERSION,
    skipDestroy: true,
    data: runnerGpuArmToolsData
  },
  { provider: usWest2Provider }
);

const runnerRecipeX86 = makeRecipe({
  id: 'RunnerRecipeX86',
  name: 'runner-x86',
  arch: 'x86',
  components: [runnerToolsComponent]
});
const runnerRecipeArm64 = makeRecipe({
  id: 'RunnerRecipeArm64',
  name: 'runner-arm64',
  arch: 'arm64',
  components: [runnerToolsComponent]
});
const runnerRecipeGpuX86 = makeRecipe({
  id: 'RunnerRecipeGpuX86',
  name: 'runner-gpu-x86',
  arch: 'x86',
  components: [runnerToolsComponent, runnerGpuX86ToolsComponent],
  volumeSizeGib: 60
});
const runnerRecipeGpuArm64 = makeRecipe({
  id: 'RunnerRecipeGpuArm64',
  name: 'runner-gpu-arm64',
  arch: 'arm64',
  components: [runnerToolsComponent, runnerGpuArmToolsComponent],
  volumeSizeGib: 60
});

const runnerBakeInfraX86 = makeBakeInfra({
  id: 'RunnerBakeInfraX86',
  name: 'runner-bake-x86',
  instanceType: 'c7i.large'
});
const runnerBakeInfraArm64 = makeBakeInfra({
  id: 'RunnerBakeInfraArm64',
  name: 'runner-bake-arm64',
  instanceType: 'c7g.large'
});
const runnerBakeInfraGpuX86 = makeBakeInfra({
  id: 'RunnerBakeInfraGpuX86',
  name: 'runner-bake-gpu-x86',
  instanceType: 'g6.xlarge'
});
const runnerBakeInfraGpuArm64 = makeBakeInfra({
  id: 'RunnerBakeInfraGpuArm64',
  name: 'runner-bake-gpu-arm64',
  instanceType: 'g5g.2xlarge'
});

export const runnerImageX86 = new aws.imagebuilder.Image(
  'RunnerImageX86',
  {
    imageRecipeArn: runnerRecipeX86.arn,
    infrastructureConfigurationArn: runnerBakeInfraX86.arn
  },
  { provider: usWest2Provider }
);
export const runnerImageArm64 = new aws.imagebuilder.Image(
  'RunnerImageArm64',
  {
    imageRecipeArn: runnerRecipeArm64.arn,
    infrastructureConfigurationArn: runnerBakeInfraArm64.arn
  },
  { provider: usWest2Provider }
);
export const runnerImageGpuX86 = new aws.imagebuilder.Image(
  'RunnerImageGpuX86',
  {
    imageRecipeArn: runnerRecipeGpuX86.arn,
    infrastructureConfigurationArn: runnerBakeInfraGpuX86.arn
  },
  { provider: usWest2Provider }
);
export const runnerImageGpuArm64 = new aws.imagebuilder.Image(
  'RunnerImageGpuArm64',
  {
    imageRecipeArn: runnerRecipeGpuArm64.arn,
    infrastructureConfigurationArn: runnerBakeInfraGpuArm64.arn
  },
  { provider: usWest2Provider }
);

const lifecycleRole = new aws.iam.Role(
  'RunnerLifecycleRole',
  {
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
  },
  { provider: usWest2Provider }
);
new aws.imagebuilder.LifecyclePolicy(
  'RunnerLifecyclePolicy',
  {
    name: `${STAGE_NAME}-runner-image-lifecycle`,
    description:
      'Keep the latest 10 runner AMI versions per recipe; delete older versions and their snapshots',
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
        { name: runnerRecipeArm64.name, semanticVersion: VERSION },
        { name: runnerRecipeGpuX86.name, semanticVersion: VERSION },
        { name: runnerRecipeGpuArm64.name, semanticVersion: VERSION }
      ]
    }
  },
  { provider: usWest2Provider }
);
