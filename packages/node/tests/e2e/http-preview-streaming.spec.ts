import { expect, test } from '@playwright/test';
import type * as RuntimeModule from '../../src/index';

test('streams HTTP chunks, SSE events, binary POST uploads, and WebSocket upgrades through Service Worker preview', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const runtimeUrl = '/runtime.js';
    const { BrowserContainer } = (await import(runtimeUrl)) as typeof RuntimeModule;
    const container = await BrowserContainer.boot();
    try {
      await container.mount({
        '/server.cjs': `
          const http = require('node:http');
          const crypto = require('node:crypto');

          const server = http.createServer((req, res) => {
            if (req.url === '/stream') {
              res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
              res.write('chunk-1|');
              setTimeout(() => {
                res.write('chunk-2|');
                setTimeout(() => res.end('chunk-3'), 15);
              }, 15);
              return;
            }
            if (req.url === '/sse') {
              res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
              });
              res.write('data: alpha\\n\\n');
              setTimeout(() => {
                res.write('data: beta\\n\\n');
                res.end();
              }, 15);
              return;
            }
            if (req.url === '/echo' && req.method === 'POST') {
              const chunks = [];
              req.on('data', (c) => chunks.push(c));
              req.on('end', () => {
                const buf = Buffer.concat(chunks);
                res.writeHead(200, { 'content-type': 'application/octet-stream' });
                res.end(buf);
              });
              return;
            }
            if (req.url === '/' || req.url === '/index.html') {
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
              res.end('<!doctype html><script>' +
                'const ws = new WebSocket(location.href);' +
                'ws.onopen = () => ws.send("ws-hello");' +
                'ws.onmessage = (e) => { document.body.dataset.ws = e.data; ws.close(); };' +
                '</script><body>ws-host</body>');
              return;
            }
            res.writeHead(404).end('missing');
          });

          server.on('upgrade', (req, socket) => {
            const key = req.headers['sec-websocket-key'];
            const accept = crypto
              .createHash('sha1')
              .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
              .digest('base64');
            socket.write(
              'HTTP/1.1 101 Switching Protocols\\r\\n' +
              'Upgrade: websocket\\r\\n' +
              'Connection: Upgrade\\r\\n' +
              'Sec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n'
            );
            socket.once('data', (frame) => {
              const len = frame[1] & 0x7f;
              const mask = frame.subarray(2, 6);
              const payload = Buffer.alloc(len);
              for (let i = 0; i < len; i++) payload[i] = frame[6 + i] ^ mask[i % 4];
              const reply = Buffer.from('ack:' + payload.toString('utf8'));
              socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
            });
          });

          server.listen(3000);
        `,
      });

      const proc = await container.spawn('node', ['/server.cjs']);
      const baseUrl = await container.preview(3000, { webSocket: true });

      // 1. Incremental HTTP response streaming
      const streamRes = await fetch(new URL('stream', baseUrl));
      const streamReader = streamRes.body!.getReader();
      const dec = new TextDecoder();
      let streamedText = '';
      let chunkReads = 0;
      while (true) {
        const { value, done } = await streamReader.read();
        if (done) break;
        chunkReads += 1;
        streamedText += dec.decode(value, { stream: true });
      }
      streamedText += dec.decode();

      // 2. Server-Sent Events
      const sseMessages = await new Promise<string[]>((resolve, reject) => {
        const received: string[] = [];
        const es = new EventSource(new URL('sse', baseUrl));
        es.onmessage = (ev) => {
          received.push(ev.data);
          if (received.length === 2) {
            es.close();
            resolve(received);
          }
        };
        es.onerror = () => {
          es.close();
          if (received.length === 2) resolve(received);
          else reject(new Error('SSE failed early'));
        };
      });

      // 3. Binary POST round-trip
      const payload = new Uint8Array(4096);
      for (let i = 0; i < payload.length; i++) payload[i] = (i * 17) & 0xff;
      const postRes = await fetch(new URL('echo', baseUrl), { method: 'POST', body: payload });
      const echoed = new Uint8Array(await postRes.arrayBuffer());
      const binaryMatch =
        echoed.byteLength === payload.byteLength &&
        echoed.every((byte, idx) => byte === payload[idx]);

      // 4. WebSocket upgrade inside preview iframe
      const frame = document.createElement('iframe');
      frame.src = baseUrl;
      document.body.append(frame);
      const wsEcho = await new Promise<string>((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          const val = frame.contentDocument?.body?.dataset.ws;
          if (val) return resolve(val);
          if (Date.now() > deadline) return reject(new Error('WebSocket timeout'));
          setTimeout(poll, 20);
        };
        poll();
      });
      frame.remove();

      proc.kill();
      await proc.exit;
      const resourcesAfterKill = await container.resources();
      return {
        streamedText,
        chunkReads,
        sseMessages,
        binaryMatch,
        wsEcho,
        resourcesAfterKill,
      };
    } finally {
      await container.teardown();
    }
  });

  expect(result.streamedText).toBe('chunk-1|chunk-2|chunk-3');
  expect(result.chunkReads).toBeGreaterThanOrEqual(2);
  expect(result.sseMessages).toEqual(['alpha', 'beta']);
  expect(result.binaryMatch).toBe(true);
  expect(result.wsEcho).toBe('ack:ws-hello');
  expect(result.resourcesAfterKill).toEqual({ processes: 0, descriptors: 0, listeners: 0 });
});

test('rebinds cleanly across compatible host Service Worker controllerchange replacements and tears down on incompatible controller takeover', async ({
  context,
  page,
}) => {
  await context.route('**/__host_sw__.js*', async (route) => {
    const swRes = await route.fetch({ url: new URL('/sw.js', route.request().url()).href });
    const swBody = await swRes.text();
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
      body: `self.addEventListener('install', () => { self.skipWaiting(); });\n${swBody}`,
    });
  });

  await context.route('**/__foreign_sw__.js*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
      body: [
        "self.addEventListener('install', () => { self.skipWaiting(); });",
        "self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });",
        "self.addEventListener('message', (event) => {",
        "  event.ports[0]?.postMessage({ type: 'registered', version: 0, ok: false });",
        '  event.ports[0]?.close();',
        '});',
      ].join('\n'),
    });
  });

  await page.goto('/');
  const result = await page.evaluate(async () => {
    const waitForControllerSuffix = async (suffix: string) => {
      if (navigator.serviceWorker.controller?.scriptURL.endsWith(suffix)) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`SW claim timeout for ${suffix}`)), 10_000);
        const onClaim = () => {
          if (navigator.serviceWorker.controller?.scriptURL.endsWith(suffix)) {
            clearTimeout(timer);
            navigator.serviceWorker.removeEventListener('controllerchange', onClaim);
            resolve();
          }
        };
        navigator.serviceWorker.addEventListener('controllerchange', onClaim);
      });
    };

    await navigator.serviceWorker.register('/__host_sw__.js?rev=1', {
      type: 'module',
      scope: '/',
    });
    await waitForControllerSuffix('/__host_sw__.js?rev=1');

    const runtimeUrl = '/runtime.js';
    const { BrowserContainer } = (await import(runtimeUrl)) as typeof RuntimeModule;
    const container = await BrowserContainer.boot({ serviceWorker: 'existing' });

    try {
      await container.mount({
        '/server.cjs': `
          const http = require('node:http');
          let hits = 0;
          http.createServer((_req, res) => {
            hits += 1;
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('hit-' + hits);
          }).listen(3000);
        `,
      });
      await container.spawn('node', ['/server.cjs']);
      const baseUrl = await container.preview(3000);

      const firstText = await (await fetch(baseUrl)).text();

      // Replace controller back-to-back with compatible runtime ServiceWorker instances
      await navigator.serviceWorker.register('/__host_sw__.js?rev=2', {
        type: 'module',
        scope: '/',
      });
      await waitForControllerSuffix('/__host_sw__.js?rev=2');
      await navigator.serviceWorker.register('/__host_sw__.js?rev=3', {
        type: 'module',
        scope: '/',
      });
      await waitForControllerSuffix('/__host_sw__.js?rev=3');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const resourcesAfterCompatibleSwap = await container.resources();
      const secondText = await (await fetch(baseUrl)).text();

      // Replace controller with an incompatible non-runtime ServiceWorker -> must tear down
      await navigator.serviceWorker.register('/__foreign_sw__.js', { scope: '/' });
      await waitForControllerSuffix('/__foreign_sw__.js');
      await new Promise((resolve) => setTimeout(resolve, 50));

      let incompatibleErrorCode = '';
      try {
        await container.resources();
      } catch (err) {
        incompatibleErrorCode = String((err as { code?: string }).code ?? '');
      }

      return {
        firstText,
        resourcesAfterCompatibleSwap,
        secondText,
        incompatibleErrorCode,
      };
    } finally {
      await container.teardown().catch(() => {});
      const reg = await navigator.serviceWorker.getRegistration('/');
      await reg?.unregister();
    }
  });

  expect(result.firstText).toBe('hit-1');
  expect(result.resourcesAfterCompatibleSwap.listeners).toBe(1);
  expect(result.secondText).toBe('hit-2');
  expect(result.incompatibleErrorCode).toBe('EPIPE');
});
