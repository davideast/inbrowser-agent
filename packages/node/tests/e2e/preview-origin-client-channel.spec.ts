import { expect, test } from '@playwright/test';
import type * as RuntimeModule from '../../src/index';

test('serves per-origin preview with root-relative routes, cookies, and clientScript/onPreviewClient MessagePort handshakes', async ({
  page,
}) => {
  const previewPort = Number(process.env.PREVIEW_PORT || '6173');
  const originTemplate = `http://{container}-{port}.localhost:${previewPort}`;

  await page.goto('/');
  const result = await page.evaluate(
    async ({ originTemplate }) => {
      const runtimeUrl = '/runtime.js';
      const { BrowserContainer } = (await import(runtimeUrl)) as typeof RuntimeModule;
      const container = await BrowserContainer.boot({
        preview: { origin: originTemplate, embedderPolicy: 'require-corp' },
      });
      try {
        await container.mount({
          '/server.cjs': `
            const http = require('node:http');
            const zlib = require('node:zlib');

            const html = (label, nextHref) =>
              '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
              '<h1 id="title">' + label + '</h1>' +
              (nextHref ? '<a id="go" href="' + nextHref + '">Go</a>' : '') +
              '<script>' +
              'fetch("/api/whoami").then(r => r.json()).then(d => { document.body.dataset.api = d.cookie; });' +
              '</script></body></html>';

            http.createServer((req, res) => {
              if (req.url === '/') {
                res.writeHead(200, {
                  'content-type': 'text/html; charset=utf-8',
                  'set-cookie': 'sid=origin-cookie-ok; Path=/; HttpOnly',
                });
                res.end(html('home', '/gzip-page'));
                return;
              }
              if (req.url === '/gzip-page') {
                const gz = zlib.gzipSync(Buffer.from(html('gzip-second', '')));
                res.writeHead(200, {
                  'content-type': 'text/html; charset=utf-8',
                  'content-encoding': 'gzip',
                  'content-length': String(gz.length),
                });
                res.end(gz);
                return;
              }
              if (req.url === '/api/whoami') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ cookie: req.headers.cookie || '' }));
                return;
              }
              if (req.url === '/missing') {
                res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
                res.end('<!doctype html><body>404-not-injected</body>');
                return;
              }
              res.writeHead(404).end('not found');
            }).listen(3000);
          `,
        });

        const proc = await container.spawn('node', ['/server.cjs']);
        const clientScript = `
          (() => {
            const port = globalThis.__inbrowserPreviewPort;
            if (!port) return;
            delete globalThis.__inbrowserPreviewPort;
            port.onmessage = (ev) => {
              if (ev.data?.type === 'ping') {
                port.postMessage({
                  type: 'pong',
                  pathname: location.pathname,
                  title: document.getElementById('title')?.textContent ?? null,
                });
              }
            };
            port.postMessage({ type: 'ready', pathname: location.pathname });
          })();
        `;

        const handshakes: Array<{ pathname: string; title: string | null }> = [];
        let notifyNext: (() => void) | null = null;
        const unsubscribe = container.onPreviewClient(3000, (port) => {
          port.onmessage = (ev) => {
            if (ev.data?.type === 'ready') {
              port.postMessage({ type: 'ping' });
            } else if (ev.data?.type === 'pong') {
              handshakes.push({ pathname: ev.data.pathname, title: ev.data.title });
              notifyNext?.();
            }
          };
        });

        const previewUrl = await container.preview(3000, { clientScript });
        const waitForCount = (n: number) =>
          new Promise<void>((resolve, reject) => {
            if (handshakes.length >= n) return resolve();
            const timer = setTimeout(
              () => reject(new Error(`Timed out waiting for ${n} handshakes`)),
              8000,
            );
            notifyNext = () => {
              if (handshakes.length >= n) {
                clearTimeout(timer);
                resolve();
              }
            };
          });

        const frame = document.createElement('iframe');
        frame.src = previewUrl;
        document.body.append(frame);
        await waitForCount(1);

        frame.src = new URL('/gzip-page', previewUrl).href;
        await waitForCount(2);

        unsubscribe();
        frame.src = new URL('/missing', previewUrl).href;
        await new Promise((r) => setTimeout(r, 150));
        frame.remove();

        proc.kill();
        await proc.exit;
        return {
          previewOrigin: new URL(previewUrl).origin,
          hostOrigin: location.origin,
          handshakes,
        };
      } finally {
        await container.teardown();
      }
    },
    { originTemplate },
  );

  expect(result.previewOrigin).not.toBe(result.hostOrigin);
  expect(result.handshakes).toEqual([
    { pathname: '/', title: 'home' },
    { pathname: '/gzip-page', title: 'gzip-second' },
  ]);
});
