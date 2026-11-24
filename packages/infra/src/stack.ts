import * as pulumi from '@pulumi/pulumi';

const stack = pulumi.getStack();
export const isProduction = stack === 'production';
export const isDev = stack === 'dev';
export const isCoreStack = isProduction || isDev;

export const STAGE_NAME = isProduction ? 'prod' : stack;
