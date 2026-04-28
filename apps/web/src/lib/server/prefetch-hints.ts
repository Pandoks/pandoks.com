import { existsSync, globSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_IMMUTABLE = '.svelte-kit/output/client/_app/immutable';

let cached: string[] | null = null;

function findAllChunkUrls(): string[] {
  if (cached) return cached;
  if (!existsSync(CLIENT_IMMUTABLE)) return [];

  const all = [
    ...globSync(join(CLIENT_IMMUTABLE, 'chunks/*.js')),
    ...globSync(join(CLIENT_IMMUTABLE, 'nodes/*.js'))
  ];

  cached = all.map((f) => `/_app/immutable/${f.split('_app/immutable/')[1]}`);
  return cached;
}

export function injectPrefetchHints(html: string): string {
  const all = findAllChunkUrls();
  if (all.length === 0) return html;
  if (html.includes('rel="prefetch"')) return html;

  const modulepreloaded = new Set<string>();
  for (const m of html.matchAll(/<link\s[^>]*rel="modulepreload"[^>]*>/g)) {
    const href = m[0].match(/href="([^"]+)"/)?.[1];
    if (href) modulepreloaded.add(href);
  }

  const toPrefetch = all.filter((u) => !modulepreloaded.has(u));
  if (toPrefetch.length === 0) return html;

  const tags = toPrefetch
    .map((u) => `<link rel="prefetch" href="${u}" as="script">`)
    .join('\n    ');

  return html.replace(
    /([ \t]*)<\/head>/,
    (_, indent: string) => `${indent}  ${tags}\n${indent}</head>`
  );
}
