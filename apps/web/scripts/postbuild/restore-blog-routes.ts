import { existsSync, renameSync, rmSync } from 'fs';
import { BLOG_ROUTE, HIDDEN_BLOG, TEMP_DIR } from '../paths';

export const restoreBlogRoutes = () => {
  if (existsSync(HIDDEN_BLOG)) {
    renameSync(HIDDEN_BLOG, BLOG_ROUTE);
    console.log('postbuild: restored blog route');
  }
  if (existsSync(TEMP_DIR)) {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  }
};
