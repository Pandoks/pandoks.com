import * as pulumi from '@pulumi/pulumi';

export const isProduction = pulumi.getStack() === 'production';

export const STAGE_NAME = isProduction ? 'prod' : 'dev';
