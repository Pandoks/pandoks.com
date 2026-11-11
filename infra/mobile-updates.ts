import {
  MOBILE_UPDATES_ASSETS_DOMAIN,
  MOBILE_UPDATES_DOMAIN,
  STAGE_NAME,
  cloudflareAccountId,
  cloudflareZoneId,
  isProduction
} from './dns';

const mobileUpdatesBucket = new sst.cloudflare.Bucket('MobileUpdatesBucket', {
  transform: {
    bucket: {
      name: `${STAGE_NAME}-mobile-updates`,
      accountId: cloudflareAccountId,
      jurisdiction: 'default',
      location: 'wnam',
      storageClass: 'Standard'
    }
  }
});

new cloudflare.R2CustomDomain('MobileUpdatesBucketDomain', {
  accountId: cloudflareAccountId,
  bucketName: mobileUpdatesBucket.name,
  domain: MOBILE_UPDATES_ASSETS_DOMAIN,
  zoneId: cloudflareZoneId,
  enabled: true
});

new sst.Linkable('MobileUpdatesAssetsDomain', {
  properties: { value: MOBILE_UPDATES_ASSETS_DOMAIN }
});

if (isProduction) {
  // NOTE: a zone has one cache ruleset and every stage shares this zone, so production's caches dev's files too
  new cloudflare.Ruleset('MobileUpdatesAssetsCacheRuleset', {
    zoneId: cloudflareZoneId,
    kind: 'zone',
    phase: 'http_request_cache_settings',
    name: 'default',
    rules: [
      {
        description: 'Cache mobile update files, which never change, at the edge',
        action: 'set_cache_settings',
        actionParameters: { cache: true, edgeTtl: { mode: 'override_origin', default: 31536000 } },
        expression:
          'http.host in {"mobile-updates-assets.pandoks.com" "mobile-updates-assets-dev.pandoks.com"}',
        enabled: true
      }
    ]
  });
}

const mobileUpdatesManifests = new sst.cloudflare.Kv('MobileUpdatesManifests');

new sst.cloudflare.Worker('MobileUpdates', {
  accountId: cloudflareAccountId,
  handler: 'apps/mobile-updates/src/index.ts',
  domain: MOBILE_UPDATES_DOMAIN,
  link: [mobileUpdatesManifests]
});
