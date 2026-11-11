import { expect, test } from '@playwright/test';
import type * as RuntimeModule from '../../src/index';

test('boots BrowserContainer, mounts VFS entries, runs CJS + ESM + sh, snapshots/restores, and tears down cleanly', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const runtimeUrl = '/runtime.js';
    const { BrowserContainer } = (await import(runtimeUrl)) as typeof RuntimeModule;
    const container = await BrowserContainer.boot();
    try {
      await container.mount({
        '/app/package.json': JSON.stringify({ name: 'demo', type: 'module' }),
        '/app/counter.js': `
          export let count = 1;
          export function inc() { count += 1; return count; }
        `,
        '/app/helper.cjs': `
          const fs = require('node:fs');
          module.exports = {
            readMsg: () => fs.readFileSync('/app/msg.txt', 'utf8'),
            loadEsm: () => import('./counter.js'),
          };
        `,
        '/app/main.js': `
          import { createRequire } from 'node:module';
          import { count, inc } from './counter.js';
          const req = createRequire(import.meta.url);
          const helper = req('./helper.cjs');
          const before = count;
          inc();
          const esmFromCjs = await helper.loadEsm();
          console.log(JSON.stringify({
            before,
            after: count,
            esmFromCjs: esmFromCjs.count,
            msg: helper.readMsg(),
          }));
        `,
        '/app/msg.txt': new TextEncoder().encode('hello-vfs'),
        '/app/ok.cjs': "process.stdout.write('OK');\n",
        '/bin/greet': {
          data: '#!/usr/bin/env node\nconsole.log("GREET:" + process.argv[2]);\n',
          mode: 0o755,
        },
      });

      const watchStream = await container.fs.watch('/app', { recursive: true });
      const reader = watchStream.getReader();
      await container.fs.writeFile('/app/extra.txt', 'watch-hit');
      const firstWatch = await reader.read();
      await reader.cancel();

      const esmProc = await container.spawn('node', ['/app/main.js'], { cwd: '/app' });
      const esmExit = await esmProc.exit;

      const shProc = await container.spawn('sh', ['-c', 'greet world && node /app/ok.cjs'], {
        cwd: '/app',
        env: { PATH: '/bin' },
      });
      const shExit = await shProc.exit;

      const snap = await container.snapshot();
      await container.fs.rm('/app/extra.txt');
      await container.restore(snap);
      const restored = await container.fs.readFile('/app/extra.txt', 'utf8');
      const stat = await container.fs.stat('/bin/greet');
      const resourcesBeforeTeardown = await container.resources();

      await container.teardown();
      return {
        esmExit,
        esmStderr: esmProc.stderrText,
        esmOut: JSON.parse(esmProc.stdoutText.trim()),
        shExit,
        shOut: shProc.stdoutText,
        watchedDone: firstWatch.done,
        restored,
        greetMode: stat.mode & 0o777,
        resourcesBeforeTeardown,
      };
    } finally {
      await container.teardown().catch(() => {});
    }
  });

  expect(result.esmStderr).toBe('');
  expect(result.esmExit).toBe(0);
  expect(result.esmOut).toEqual({
    before: 1,
    after: 2,
    esmFromCjs: 2,
    msg: 'hello-vfs',
  });
  expect(result.shExit).toBe(0);
  expect(result.shOut).toBe('GREET:world\nOK');
  expect(result.watchedDone).toBe(false);
  expect(result.restored).toBe('watch-hit');
  expect(result.greetMode).toBe(0o755);
  expect(result.resourcesBeforeTeardown).toEqual({
    processes: 0,
    descriptors: 0,
    listeners: 0,
  });
});
