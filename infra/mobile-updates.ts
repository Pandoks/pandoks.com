import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cloudflare from '@pulumi/cloudflare';
import {
  MOBILE_UPDATES_ASSETS_DOMAIN,
  MOBILE_UPDATES_DOMAIN,
  STAGE_NAME,
  cloudflareAccountId,
  cloudflareZoneId,
  isProduction
} from './dns.ts';

const mobileUpdatesDirectory = join(import.meta.dirname, '../apps/mobile-updates');
const wranglerConfig = JSON.parse(
  readFileSync(join(mobileUpdatesDirectory, 'wrangler.json'), 'utf8')
) as { compatibility_date: string };

// NOTE: wrangler bundles the Worker the same way for `wrangler dev` and for this deploy
const bundleDirectory = mkdtempSync(join(tmpdir(), 'mobile-updates-worker-'));
let mobileUpdatesBundle: string;
try {
  execFileSync(
    join(import.meta.dirname, '../node_modules/.bin/wrangler'),
    ['deploy', '--dry-run', '--outdir', bundleDirectory],
    { cwd: mobileUpdatesDirectory, stdio: ['ignore', 'ignore', 'inherit'] }
  );
  mobileUpdatesBundle = readFileSync(join(bundleDirectory, 'index.js'), 'utf8');
} finally {
  rmSync(bundleDirectory, { recursive: true, force: true });
}

export const mobileUpdatesBucket = new cloudflare.R2Bucket('MobileUpdatesBucket', {
  name: `${STAGE_NAME}-mobile-updates`,
  accountId: cloudflareAccountId,
  jurisdiction: 'default',
  location: 'wnam',
  storageClass: 'Standard'
});

new cloudflare.R2CustomDomain('MobileUpdatesBucketDomain', {
  accountId: cloudflareAccountId,
  bucketName: mobileUpdatesBucket.name,
  domain: MOBILE_UPDATES_ASSETS_DOMAIN,
  zoneId: cloudflareZoneId,
  enabled: true
});

if (isProduction) {
  // NOTE: a zone has one cache ruleset and every stack shares this zone, so production's caches non-prod files too
  new cloudflare.Ruleset('MobileUpdatesAssetsCacheRuleset', {
    zoneId: cloudflareZoneId,
    kind: 'zone',
    phase: 'http_request_cache_settings',
    name: 'default',
    rules: [
      {
        description: 'Cache mobile update files, which never change, at the edge',
        action: 'set_cache_settings',
        actionParameters: {
          cache: true,
          edgeTtl: {
            mode: 'respect_origin',
            statusCodeTtls: [
              { statusCodeRange: { to: 299 }, value: 31536000 },
              { statusCodeRange: { from: 400 }, value: -1 }
            ]
          }
        },
        expression:
          'http.host eq "mobile-updates-assets.pandoks.com" or starts_with(http.host, "mobile-updates-assets-")',
        enabled: true
      }
    ]
  });
}

export const mobileUpdatesManifests = new cloudflare.WorkersKvNamespace('MobileUpdatesManifests', {
  accountId: cloudflareAccountId,
  title: `${STAGE_NAME}-mobile-updates-manifests`
});

const mobileUpdatesWorker = new cloudflare.WorkersScript('MobileUpdatesWorker', {
  accountId: cloudflareAccountId,
  scriptName: `${STAGE_NAME}-mobile-updates`,
  content: mobileUpdatesBundle,
  mainModule: 'index.js',
  compatibilityDate: wranglerConfig.compatibility_date,
  observability: { enabled: true },
  bindings: [
    {
      type: 'kv_namespace',
      name: 'MOBILE_UPDATES_MANIFESTS',
      namespaceId: mobileUpdatesManifests.id
    }
  ]
});

new cloudflare.WorkersCustomDomain('MobileUpdatesDomain', {
  accountId: cloudflareAccountId,
  zoneId: cloudflareZoneId,
  hostname: MOBILE_UPDATES_DOMAIN,
  service: mobileUpdatesWorker.scriptName
});

export const outputs = {
  MobileUpdatesBucket: mobileUpdatesBucket.name,
  MobileUpdatesManifestsNamespaceId: mobileUpdatesManifests.id,
  MobileUpdatesAssetsDomain: MOBILE_UPDATES_ASSETS_DOMAIN
};
