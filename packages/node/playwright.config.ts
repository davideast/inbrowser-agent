import { defineConfig } from '@playwright/test';

const port = process.env.PORT || '4173';
const baseURL = `http://127.0.0.1:${port}`;
const previewPort = process.env.PREVIEW_PORT || String(Number(port) + 1);
const sandboxPort = process.env.SANDBOX_PORT || String(Number(port) + 2);
process.env.PREVIEW_PORT = previewPort;
process.env.SANDBOX_PORT = sandboxPort;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  workers: 1,
  reporter: 'list',
  use: { browserName: 'chromium', baseURL },
  webServer: {
    command: 'node scripts/serve-e2e.mjs',
    env: { PORT: port, PREVIEW_PORT: previewPort, SANDBOX_PORT: sandboxPort },
    url: baseURL,
    reuseExistingServer: false,
  },
});
