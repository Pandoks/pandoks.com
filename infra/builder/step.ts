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
