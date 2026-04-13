import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const WEB_DIR = process.cwd();
const BUILD_DIR = join(WEB_DIR, 'build');

export function injectRouteList(htmlFiles: string[]) {
  const allRoutes = htmlFiles.map((f) => {
    const rel = f
      .replace(BUILD_DIR, '')
      .replace(/\/index\.html$/, '')
      .replace(/\.html$/, '');
    return rel || '/';
  });

  const script = `<script>window.__ALL_ROUTES=${JSON.stringify(allRoutes)}</script>`;

  for (const f of htmlFiles) {
    const html = readFileSync(f, 'utf-8');
    writeFileSync(f, html.replace('</head>', `${script}</head>`));
  }

  console.log(`postbuild: Injected ${allRoutes.length} routes for preloading`);
}
