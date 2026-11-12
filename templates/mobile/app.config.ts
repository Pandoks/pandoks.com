import type { ConfigContext } from 'expo/config';

// NOTE: builds read production updates unless built with MOBILE_UPDATES_ENVIRONMENT=dev
export default ({ config }: ConfigContext) => ({
  ...config,
  updates: {
    ...config.updates,
    url: `https://${process.env.MOBILE_UPDATES_ENVIRONMENT === 'dev' ? 'mobile-updates-dev' : 'mobile-updates'}.pandoks.com/${config.slug}`
  }
});
