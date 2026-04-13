import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const WEB_DIR = process.cwd();
const TEMP_DIR = join(WEB_DIR, '.temp');

export function restoreBlogRoutes() {
  if (!existsSync(TEMP_DIR)) {
    console.log('postbuild: No .temp directory found');
    return;
  }

  const tempBlogDir = join(TEMP_DIR, 'src', 'routes', 'blog', '[title]');
  const blogDir = join(WEB_DIR, 'src', 'routes', 'blog');

  if (existsSync(tempBlogDir)) {
    execSync(`mv "${tempBlogDir}" "${join(blogDir, '[title]')}"`, { stdio: 'inherit' });
    console.log('postbuild: Restored blog routes from .temp directory');
  }

  execSync(`rm -rf "${TEMP_DIR}"`, { stdio: 'inherit' });
  console.log('postbuild: Removed .temp directory');
}
