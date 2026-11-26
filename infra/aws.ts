import * as aws from '@pulumi/aws';

export const US_WEST_2_REGION = 'us-west-2';
export const usWest2Provider = new aws.Provider('UsWest2', {
  region: US_WEST_2_REGION,
  allowedAccountIds: aws.config.allowedAccountIds
});

const defaultAwsRegionJson = await aws.getRegion();
export const defaultAwsRegion = defaultAwsRegionJson.region;
