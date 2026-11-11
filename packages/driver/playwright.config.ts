import { defineConfig } from '@playwright/test';

const hostPort = process.env['DRIVER_TEST_PORT'] ?? '4700';
const framePort = process.env['DRIVER_FRAME_PORT'] ?? String(Number(hostPort) + 1);
process.env['DRIVER_TEST_PORT'] = hostPort;
process.env['DRIVER_FRAME_PORT'] = framePort;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  testIgnore: ['unit/**'],
  globalSetup: './tests/global-setup.ts',
  timeout: 30_000,
  workers: 1,
  retries: 0,
  use: {
    browserName: 'chromium',
    headless: true,
  },
});
