import { existsSync } from 'fs';
import { join } from 'path';
import { restoreBlogRoutes } from './postbuild/restore-blog-routes';
import { initFontSubsetting, injectCriticalFonts } from './postbuild/critical-fonts';
import { injectRouteList } from './postbuild/preload-routes';
import { findHtmlFiles } from './postbuild/utils';

const BUILD_DIR = join(process.cwd(), 'build');

restoreBlogRoutes();

if (existsSync(BUILD_DIR)) {
  await initFontSubsetting();
  const htmlFiles = findHtmlFiles(BUILD_DIR);

  console.log(`postbuild: Processing ${htmlFiles.length} HTML files...`);
  for (const f of htmlFiles) {
    injectCriticalFonts(f);
  }

  injectRouteList(htmlFiles);
  console.log('postbuild: Done');
} else {
  console.log('postbuild: No build directory found, skipping');
}
