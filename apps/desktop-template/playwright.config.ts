import { execFileSync } from 'node:child_process';
import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;
const ciPort = 4173;
const previewUrl = isCI
  ? `http://localhost:${ciPort}`
  : execFileSync('portless', ['get', 'desktop-template-preview'], {
      encoding: 'utf8'
    }).trim();

const previewCommand = isCI ? `pnpm exec vite preview --port ${ciPort}` : 'pnpm preview';
const command = `pnpm build && ${previewCommand}`;

export default defineConfig({
  webServer: {
    command,
    url: previewUrl,
    ignoreHTTPSErrors: true
  },
  use: { baseURL: previewUrl, ignoreHTTPSErrors: true },
  testDir: 'e2e'
});
