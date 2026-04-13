import { globSync } from 'fs';
import { join } from 'path';

export function findHtmlFiles(dir: string): string[] {
  return globSync(join(dir, '**/*.html'));
}
