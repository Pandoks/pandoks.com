import type { ConfigContext } from 'expo/config';

const environment = process.env.MOBILE_UPDATES_ENVIRONMENT;
const updatesHost =
  environment && environment !== 'production'
    ? `mobile-updates-${environment}.pandoks.com`
    : 'mobile-updates.pandoks.com';

export default ({ config }: ConfigContext) => ({
  ...config,
  updates: {
    ...config.updates,
    url: `https://${updatesHost}/${config.slug}`
  }
});
