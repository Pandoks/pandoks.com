import type { ConfigContext } from 'expo/config';

// NOTE: builds read production updates unless built with UPDATES_ENVIRONMENT=dev
export default ({ config }: ConfigContext) => ({
  ...config,
  updates: {
    ...config.updates,
    url: `https://updates.${process.env.UPDATES_ENVIRONMENT === 'dev' ? 'dev.' : ''}pandoks.com/${config.slug}`
  }
});
