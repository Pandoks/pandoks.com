/**
 * NOTE: this file is used by both the infra and the apps/functions. we do this to avoid functions
 * importing SST specifics and causing type errors. this also allows up to sync up the instances
 * to gate.
 */
export const ARM_INSTANCE_TYPES = [
  'c7g.large',
  'c7g.xlarge',
  'c7g.2xlarge',
  'c7g.4xlarge',
  'c7g.8xlarge',
  'c7g.12xlarge',
  'c7g.16xlarge',
  'c8g.large',
  'c8g.xlarge',
  'c8g.2xlarge',
  'c8g.4xlarge',
  'c8g.8xlarge',
  'c8g.12xlarge',
  'c8g.16xlarge',
  'c8g.24xlarge',
  'c8g.48xlarge',
  'm7g.large',
  'm7g.xlarge',
  'm7g.2xlarge',
  'm7g.4xlarge',
  'm7g.8xlarge',
  'm7g.12xlarge',
  'm7g.16xlarge',
  'm8g.large',
  'm8g.xlarge',
  'm8g.2xlarge',
  'm8g.4xlarge',
  'm8g.8xlarge',
  'm8g.12xlarge',
  'm8g.16xlarge',
  'm8g.24xlarge',
  'm8g.48xlarge'
] as const;

export const X86_INSTANCE_TYPES = [
  'c7i.large',
  'c7i.xlarge',
  'c7i.2xlarge',
  'c7i.4xlarge',
  'c7i.8xlarge',
  'c7i.12xlarge',
  'c7i.16xlarge',
  'c7i.24xlarge',
  'c7i.48xlarge',
  'c7i.metal-24xl',
  'c7i.metal-48xl',
  'c8i.large',
  'c8i.xlarge',
  'c8i.2xlarge',
  'c8i.4xlarge',
  'c8i.8xlarge',
  'c8i.12xlarge',
  'c8i.16xlarge',
  'c8i.24xlarge',
  'c8i.48xlarge',
  'c8i.metal-24xl',
  'c8i.metal-48xl',
  'c8a.large',
  'c8a.xlarge',
  'c8a.2xlarge',
  'c8a.4xlarge',
  'c8a.8xlarge',
  'c8a.12xlarge',
  'c8a.16xlarge',
  'c8a.24xlarge',
  'c8a.48xlarge',
  'm7i.large',
  'm7i.xlarge',
  'm7i.2xlarge',
  'm7i.4xlarge',
  'm7i.8xlarge',
  'm7i.12xlarge',
  'm7i.16xlarge',
  'm7i.24xlarge',
  'm7i.48xlarge',
  'm8i.large',
  'm8i.xlarge',
  'm8i.2xlarge',
  'm8i.4xlarge',
  'm8i.8xlarge',
  'm8i.12xlarge',
  'm8i.16xlarge',
  'm8i.24xlarge',
  'm8i.48xlarge',
  'm8i.metal-24xl',
  'm8i.metal-48xl'
] as const;

// WARNING: EXPENSIVE
export const GPU_X86_INSTANCE_TYPES = [
  // G6 — NVIDIA L4 (24GB). Cost-efficient inference, video transcode, light training.
  'g6.xlarge',
  'g6.2xlarge',
  'g6.4xlarge',
  'g6.8xlarge',
  'g6.12xlarge',
  'g6.16xlarge',
  'g6.24xlarge',
  'g6.48xlarge',
  // G5 — NVIDIA A10G (24GB). Prior-gen inference/graphics; broad availability.
  'g5.xlarge',
  'g5.2xlarge',
  'g5.4xlarge',
  'g5.8xlarge',
  'g5.12xlarge',
  'g5.16xlarge',
  'g5.24xlarge',
  'g5.48xlarge',
  // G4dn — NVIDIA T4 (16GB). Cheapest GPU, oldest gen; fine for small inference / ML CI.
  'g4dn.xlarge',
  'g4dn.2xlarge',
  'g4dn.4xlarge',
  'g4dn.8xlarge',
  'g4dn.12xlarge',
  'g4dn.16xlarge',
  'g4dn.metal',
  // G6e — NVIDIA L40S (48GB). Most cost-efficient for genAI inference; 2x G6 memory.
  'g6e.xlarge',
  'g6e.2xlarge',
  'g6e.4xlarge',
  'g6e.8xlarge',
  'g6e.12xlarge',
  'g6e.16xlarge',
  'g6e.24xlarge',
  'g6e.48xlarge',
  // P5 — NVIDIA H100 (up to 8 GPUs). Large-scale training/HPC.
  'p5.4xlarge',
  'p5.48xlarge',
  // P5e — NVIDIA H200 (8 GPUs). Bigger-memory training.
  'p5e.48xlarge',
  // P5en — NVIDIA H200 + faster networking.
  'p5en.48xlarge'
] as const;

export const GPU_ARM_INSTANCE_TYPES = [
  // G5g — NVIDIA T4G (16GB) on Graviton (arm64). Cheap arm64 GPU for inference / Android-game stream.
  'g5g.xlarge',
  'g5g.2xlarge',
  'g5g.4xlarge',
  'g5g.8xlarge',
  'g5g.16xlarge',
  'g5g.metal'
] as const;

export const SUPPORTED_INSTANCE_TYPES = [
  ...ARM_INSTANCE_TYPES,
  ...X86_INSTANCE_TYPES,
  ...GPU_X86_INSTANCE_TYPES,
  ...GPU_ARM_INSTANCE_TYPES
] as const;

export type InstanceType = (typeof SUPPORTED_INSTANCE_TYPES)[number];
