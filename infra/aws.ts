import { secrets, setSecret } from './secrets';

export const US_WEST_2_REGION = 'us-west-2';
export const usWest2Provider = new aws.Provider('UsWest2', { region: US_WEST_2_REGION });

const defaultAwsRegionJson = await aws.getRegion();
export const defaultAwsRegion = defaultAwsRegionJson.region;
secrets.aws.Region.value.apply((region) => {
  if (region !== defaultAwsRegion) {
    setSecret(secrets.aws.Region.name, defaultAwsRegion);
  }
});
