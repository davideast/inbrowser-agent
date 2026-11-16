import { expect, test } from '@playwright/test';
import type * as RuntimeModule from '../../src/index';

test('propagates AsyncLocalStorage and AsyncResource across async/await, timers, and concurrent HTTP requests', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const runtimeUrl = '/runtime.js';
    const { BrowserContainer } = (await import(runtimeUrl)) as typeof RuntimeModule;
    const container = await BrowserContainer.boot({ asyncContext: 'experimental' });
    try {
      await container.mount({
        '/store.cjs': `
          const { AsyncLocalStorage, AsyncResource } = require('node:async_hooks');
          const store = new AsyncLocalStorage();
          module.exports = { store, AsyncResource };
        `,
        '/server.mjs': `
          import http from 'node:http';
          import { createRequire } from 'node:module';
          const req = createRequire(import.meta.url);
          const { store, AsyncResource } = req('./store.cjs');

          async function stepOne() {
            await new Promise((r) => setTimeout(r, 10));
            return store.getStore()?.reqId;
          }

          http.createServer((request, response) => {
            const url = new URL(request.url, 'http://localhost');
            const reqId = url.searchParams.get('id') || 'none';
            const delay = Number(url.searchParams.get('delay') || '5');
            store.run({ reqId }, async () => {
              const resource = new AsyncResource('DeferredCheck');
              const first = await stepOne();
              setTimeout(() => {
                const viaTimer = store.getStore()?.reqId;
                const viaResource = resource.runInAsyncScope(() => store.getStore()?.reqId);
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ reqId, first, viaTimer, viaResource }));
              }, delay);
            });
          }).listen(3000);
        `,
      });

      const proc = await container.spawn('node', ['/server.mjs']);
      const baseUrl = await container.preview(3000);

      const requests = [
        fetch(`${baseUrl}?id=req-A&delay=25`).then((r) => r.json()),
        fetch(`${baseUrl}?id=req-B&delay=5`).then((r) => r.json()),
        fetch(`${baseUrl}?id=req-C&delay=15`).then((r) => r.json()),
        fetch(`${baseUrl}?id=req-D&delay=10`).then((r) => r.json()),
      ];
      const replies = await Promise.all(requests);

      proc.kill();
      await proc.exit;
      return { stderr: proc.stderrText, replies };
    } finally {
      await container.teardown();
    }
  });

  expect(result.stderr).toBe('');
  expect(result.replies).toEqual([
    { reqId: 'req-A', first: 'req-A', viaTimer: 'req-A', viaResource: 'req-A' },
    { reqId: 'req-B', first: 'req-B', viaTimer: 'req-B', viaResource: 'req-B' },
    { reqId: 'req-C', first: 'req-C', viaTimer: 'req-C', viaResource: 'req-C' },
    { reqId: 'req-D', first: 'req-D', viaTimer: 'req-D', viaResource: 'req-D' },
  ]);
});

test('keeps Function and intrinsic function constructors constructible with new under experimental asyncContext', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const runtimeUrl = '/runtime.js';
    const { BrowserContainer } = (await import(runtimeUrl)) as typeof RuntimeModule;
    const container = await BrowserContainer.boot({ asyncContext: 'experimental' });
    try {
      await container.mount({
        '/check.cjs': `
          const { AsyncLocalStorage } = require('node:async_hooks');
          const store = new AsyncLocalStorage();
          const sum = new Function('a', 'b', 'return a + b')(1, 2);
          const called = Function('a', 'b', 'return a + b')(1, 2);
          const viaContext = new Function(
            'store',
            'return store.run("ctx-ok", async () => { await Promise.resolve(); return store.getStore(); })',
          );
          const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
          const asyncConstructed = new AsyncFn(
            'store',
            'await Promise.resolve(); return store.getStore();',
          );
          Promise.all([
            viaContext(store),
            store.run('async-ctor-ok', () => asyncConstructed(store)),
          ]).then(([fromFunction, fromAsyncFunction]) => {
            process.stdout.write(
              JSON.stringify({ sum, called, fromFunction, fromAsyncFunction }),
            );
          });
        `,
      });

      const proc = await container.spawn('node', ['/check.cjs']);
      const exitCode = await proc.exit;
      return {
        exitCode,
        stdout: proc.stdoutText,
        stderr: proc.stderrText,
      };
    } finally {
      await container.teardown();
    }
  });

  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    sum: 3,
    called: 3,
    fromFunction: 'ctx-ok',
    fromAsyncFunction: 'async-ctor-ok',
  });
});
