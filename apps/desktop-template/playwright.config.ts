import { execFileSync } from 'node:child_process';
import { defineConfig } from '@playwright/test';

const previewUrl = execFileSync('portless', ['get', 'desktop-template-preview'], {
  encoding: 'utf8'
}).trim();

export default defineConfig({
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: previewUrl,
    ignoreHTTPSErrors: true
  },
  use: { baseURL: previewUrl, ignoreHTTPSErrors: true },
  testDir: 'e2e'
});
