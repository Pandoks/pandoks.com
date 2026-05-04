import { building } from '$app/environment';
import { readFileSync } from 'node:fs';

const bundledJs = building
  ? Object.values(
      JSON.parse(readFileSync('.svelte-kit/output/client/.vite/manifest.json', 'utf-8')) as Record<
        string,
        { file: string }
      >
    )
      .map((entry) => entry.file)
      .filter((file) => file.endsWith('.js'))
      .map((file) => `/${file}`)
  : [];

export function injectPrefetchHints(html: string): string {
  const existingPreloads = new Set<string>();
  for (const preload of html.matchAll(/<link\s[^>]*rel="modulepreload"[^>]*>/g)) {
    const href = preload[0].match(/href="([^"]+)"/)?.[1];
    if (href) existingPreloads.add(href);
  }

  const tags = bundledJs
    .filter((url) => !existingPreloads.has(url))
    .map((url) => `<link rel="modulepreload" href="${url}">`)
    .join('\n    ');

  return tags ? html.replace('</head>', `  ${tags}\n  </head>`) : html;
}
