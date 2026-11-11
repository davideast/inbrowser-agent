import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import type * as RuntimeModule from '../../src/index';

test('isolates parent, sandbox host, and preview across 3 origins with quota clamping, egress rules, and clean dispose', async ({
  page,
}) => {
  const hostPort = Number(process.env.PORT || '4173');
  const sandboxPort = Number(process.env.SANDBOX_PORT || String(hostPort + 3000));
  const sbOrigin = `http://sandbox.localhost:${sandboxPort}`;

  const allowedApi = createServer((_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('egress-allowed-ok');
  });
  const blockedApi = createServer((_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('should-not-reach');
  });
  allowedApi.listen(0, '127.0.0.1');
  blockedApi.listen(0, '127.0.0.1');
  await Promise.all([once(allowedApi, 'listening'), once(blockedApi, 'listening')]);

  const allowedAddr = allowedApi.address();
  const blockedAddr = blockedApi.address();
  if (
    !allowedAddr ||
    typeof allowedAddr === 'string' ||
    !blockedAddr ||
    typeof blockedAddr === 'string'
  ) {
    throw new Error('Failed to bind local test HTTP servers');
  }

  try {
    await page.goto('/');
    const phase1 = await page.evaluate(
      async ({ sbOrigin, allowedPort, blockedPort }) => {
        document.cookie = 'parent_session=top-secret-cookie; path=/';
        localStorage.setItem('parent_secret_token', 'secret-ls-value');
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('parent-private-db', 1);
          req.onsuccess = () => {
            req.result.close();
            resolve();
          };
          req.onerror = () => reject(req.error);
        });

        const runtimeUrl = '/runtime.js';
        const { SandboxContainer, LimitError } = (await import(runtimeUrl)) as typeof RuntimeModule;

        const sandbox = await SandboxContainer.boot(`${sbOrigin}/sandbox.html`, {
          bootOptions: {
            httpAgentMode: 'fetch',
            httpAllowedHosts: [`127.0.0.1:${allowedPort}`],
            resources: {
              filesystem: { maxTotalBytes: 4096 },
            },
          },
        });
        Reflect.set(window, '__activeSandbox', sandbox);

        await sandbox.mount({
          '/egress.cjs': `
            const http = require('node:http');
            const get = (url) => new Promise((resolve) => {
              http.get(url, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => resolve(data));
              }).on('error', (err) => resolve('ERR:' + err.code));
            });
            const keepAlive = setInterval(() => {}, 1000);
            (async () => {
              try {
                const ok = await get('http://127.0.0.1:${allowedPort}/ok');
                const denied = await get('http://127.0.0.1:${blockedPort}/denied');
                const dbs = typeof indexedDB !== 'undefined' && indexedDB.databases
                  ? (await indexedDB.databases()).map((d) => d.name)
                  : [];
                console.log(JSON.stringify({ origin: self.origin, ok, denied, dbs }));
              } finally {
                clearInterval(keepAlive);
              }
            })();
          `,
          '/server.cjs': `
            const http = require('node:http');
            const html = '<!doctype html><body><script>' +
              '(async () => {' +
              '  let parentDom = "accessible";' +
              '  let topDom = "accessible";' +
              '  try { void window.parent.document.body; } catch (e) { parentDom = e.name; }' +
              '  try { void window.top.document.body; } catch (e) { topDom = e.name; }' +
              '  const dbs = (await indexedDB.databases()).map((d) => d.name);' +
              '  document.body.dataset.probe = JSON.stringify({' +
              '    origin: location.origin,' +
              '    cookie: document.cookie,' +
              '    ls: localStorage.getItem("parent_secret_token"),' +
              '    dbs,' +
              '    parentDom,' +
              '    topDom,' +
              '  });' +
              '  globalThis.__inbrowserPreviewPort?.postMessage({ type: "3origin-ready", origin: location.origin });' +
              '})();' +
              '</script>preview</body>';
            http.createServer((_req, res) => {
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
              res.end(html);
            }).listen(3000);
          `,
        });

        let quotaCode: unknown = null;
        let quotaIsLimit = false;
        try {
          await sandbox.writeFile('/too-big.bin', new Uint8Array(8192));
        } catch (err) {
          quotaIsLimit = err instanceof LimitError;
          quotaCode = typeof err === 'object' && err !== null ? Reflect.get(err, 'code') : null;
        }

        const egressProc = await sandbox.spawn('node', ['/egress.cjs']);
        const egressExit = await egressProc.exit;

        await sandbox.spawn('node', ['/server.cjs']);
        let clientChannelMsg: unknown = null;
        const clientChannelReady = new Promise<void>((resolve) => {
          sandbox.onPreviewClient(3000, (port) => {
            port.onmessage = (ev) => {
              clientChannelMsg = ev.data;
              resolve();
            };
          });
        });

        const previewUrl = await sandbox.preview(3000, { clientScript: '/* enable port */' });
        const frame = document.createElement('iframe');
        frame.id = 'preview-3origin';
        frame.src = previewUrl;
        document.body.append(frame);
        await clientChannelReady;

        return {
          parentOrigin: location.origin,
          sandboxOrigin: sandbox.origin,
          previewUrl,
          quotaIsLimit,
          quotaCode,
          egressExit,
          egressStderr: egressProc.stderrText,
          egressOut: JSON.parse(egressProc.stdoutText.trim()),
          clientChannelMsg,
        };
      },
      { sbOrigin, allowedPort: allowedAddr.port, blockedPort: blockedAddr.port },
    );

    const previewOrigin = new URL(phase1.previewUrl).origin;
    expect(new Set([phase1.parentOrigin, phase1.sandboxOrigin, previewOrigin]).size).toBe(3);
    expect(phase1.quotaIsLimit).toBe(true);
    expect(phase1.quotaCode).toBe('ENOSPC');
    expect(phase1.egressStderr).toBe('');
    expect(phase1.egressExit).toBe(0);
    expect(phase1.egressOut).toEqual({
      origin: sbOrigin,
      ok: 'egress-allowed-ok',
      denied: 'ERR:EACCES',
      dbs: [],
    });
    expect(phase1.clientChannelMsg).toEqual({
      type: '3origin-ready',
      origin: previewOrigin,
    });

    const previewFrame = page.frames().find((f) => f.url() === phase1.previewUrl);
    expect(previewFrame).toBeDefined();
    await expect
      .poll(() => previewFrame!.evaluate(() => document.body?.dataset.probe ?? null))
      .not.toBeNull();
    const probe = JSON.parse(
      await previewFrame!.evaluate(() => document.body.dataset.probe ?? '{}'),
    );
    expect(probe).toEqual({
      origin: previewOrigin,
      cookie: '',
      ls: null,
      dbs: [],
      parentDom: 'SecurityError',
      topDom: 'SecurityError',
    });

    const disposed = await page.evaluate(async () => {
      document.getElementById('preview-3origin')?.remove();
      const sandbox = Reflect.get(window, '__activeSandbox') as RuntimeModule.SandboxContainer;
      await sandbox.dispose();
      return document.querySelectorAll('iframe').length;
    });
    expect(disposed).toBe(0);
  } finally {
    allowedApi.close();
    blockedApi.close();
  }
});
