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

export const SUPPORTED_INSTANCE_TYPES = [
  ...ARM_INSTANCE_TYPES,
  ...X86_INSTANCE_TYPES
] as const;

export type InstanceType = (typeof SUPPORTED_INSTANCE_TYPES)[number];
