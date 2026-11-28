import { join } from 'node:path';
import * as cloudflare from '@pulumi/cloudflare';
import { buildSync } from 'esbuild';
import { STAGE_NAME } from '@pandoks.com/infra/stack';
import { cloudflareAccountId, cloudflareZoneId, domain } from './dns.ts';
import { secrets } from './secrets.ts';

const WORKER_COMPATIBILITY_DATE = '2026-11-04';
const transcribeDomain = `transcribe.${domain}`;
const scriptName = `${STAGE_NAME}-transcribe`;

const correctionsNamespace = new cloudflare.WorkersKvNamespace('TranscribeCorrections', {
  accountId: cloudflareAccountId,
  title: `${scriptName}-corrections`
});

const [bundle] = buildSync({
  entryPoints: [join(import.meta.dirname, '../apps/transcribe/src/index.ts')],
  bundle: true,
  minify: true,
  platform: 'neutral',
  target: 'es2024',
  format: 'esm',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'],
  write: false
}).outputFiles;

const worker = new cloudflare.WorkersScript('TranscribeWorker', {
  accountId: cloudflareAccountId,
  scriptName,
  mainModule: 'index.js',
  content: bundle.text,
  compatibilityDate: WORKER_COMPATIBILITY_DATE,
  bindings: [
    { name: 'AI', type: 'ai' },
    { name: 'CORRECTIONS', type: 'kv_namespace', namespaceId: correctionsNamespace.id },
    { name: 'AUTH_TOKEN', type: 'secret_text', text: secrets.transcribe.AuthToken }
  ]
});

new cloudflare.WorkersCustomDomain('TranscribeDomain', {
  accountId: cloudflareAccountId,
  zoneId: cloudflareZoneId,
  hostname: transcribeDomain,
  service: worker.scriptName
});

export const outputs = { TranscribeUrl: `https://${transcribeDomain}` };
