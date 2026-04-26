import { existsSync, globSync } from 'fs';
import { join } from 'path';
import { BUILD_DIR } from './paths';
import { restoreBlogRoutes } from './postbuild/restore-blog-routes';
import { injectCriticalFonts } from './postbuild/critical-fonts';

restoreBlogRoutes();

if (existsSync(BUILD_DIR)) {
  const htmlFiles = globSync(join(BUILD_DIR, '**/*.html'));

  console.log(`postbuild: Processing ${htmlFiles.length} HTML files...`);
  await Promise.all(htmlFiles.map((htmlFile) => injectCriticalFonts(htmlFile)));
  console.log('postbuild: Done');
} else {
  console.log('postbuild: No build directory found, skipping');
}
