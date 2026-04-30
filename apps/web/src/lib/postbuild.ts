import { existsSync, globSync } from 'fs';
import { join } from 'path';
import { woff2 } from 'fonteditor-core';
import { restoreBlogRoutes } from './postbuild/restore-blog-routes';
import { injectCriticalFonts } from './postbuild/critical-fonts';
import { injectRouteList } from './postbuild/preload-routes';

const BUILD_DIR = join(process.cwd(), 'build');

restoreBlogRoutes();

if (existsSync(BUILD_DIR)) {
  await woff2.init();
  const htmlFiles = globSync(join(BUILD_DIR, '**/*.html'));

  console.log(`postbuild: Processing ${htmlFiles.length} HTML files...`);
  for (const f of htmlFiles) {
    injectCriticalFonts(f);
  }

  injectRouteList(htmlFiles);
  console.log('postbuild: Done');
} else {
  console.log('postbuild: No build directory found, skipping');
}
