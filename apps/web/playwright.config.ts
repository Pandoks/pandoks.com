import { execFileSync } from 'node:child_process';
import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;
const ciPort = 4173;
const previewUrl = isCI
  ? `http://localhost:${ciPort}`
  : execFileSync('portless', ['get', 'web-preview'], { encoding: 'utf8' }).trim();

// In CI avoid nested `pnpm` under Playwright's webServer. Concurrent
// `pnpm run` + nested `pnpm build`/`pnpm exec` deadlocks under pnpm 12.6
// (e2e hangs after "Running 1 test using 1 worker" until the 6h job timeout).
const previewCommand = isCI ? `vite preview --port ${ciPort}` : 'pnpm preview';
const command = isCI ? `vite build && ${previewCommand}` : `pnpm build && ${previewCommand}`;

export default defineConfig({
  timeout: 60_000,
  expect: { timeout: 15_000 },
  webServer: {
    command,
    url: previewUrl,
    ignoreHTTPSErrors: true,
    timeout: 180_000,
    reuseExistingServer: !isCI
  },
  use: {
    baseURL: previewUrl,
    ignoreHTTPSErrors: true,
    navigationTimeout: 30_000,
    actionTimeout: 15_000
  },
  testDir: 'e2e'
});
