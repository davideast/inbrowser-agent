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
