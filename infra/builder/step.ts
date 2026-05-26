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
      })
  );
}
