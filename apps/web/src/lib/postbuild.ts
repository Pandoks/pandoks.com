import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const WEB_DIR = process.cwd();
const TEMP_DIR = join(WEB_DIR, '.temp');

if (!existsSync(TEMP_DIR)) {
  console.log('postbuild: No .temp directory found');
  process.exit(0);
}

export const restoreBlogRoutes = () => {
  const tempBlogDir = join(TEMP_DIR, 'src', 'routes', 'blog', '[title]');
  const blogDir = join(WEB_DIR, 'src', 'routes', 'blog');

  if (existsSync(tempBlogDir)) {
    execSync(`mv "${tempBlogDir}" "${join(blogDir, '[title]')}"`, { stdio: 'inherit' });
    console.log('restoreBlogRoutes: Restored blog routes from .temp directory');
  }
};

restoreBlogRoutes();
execSync(`rm -rf "${TEMP_DIR}"`, { stdio: 'inherit' });
console.log('postbuild: Removed .temp directory');
