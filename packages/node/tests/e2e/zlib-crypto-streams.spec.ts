import { expect, test } from '@playwright/test';
import type * as RuntimeModule from '../../src/index';

test('runs WASM brotli/zstd + gzip, crypto, stream toWeb/fromWeb, v8 serializer, and worker_threads in Chromium', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const runtimeUrl = '/runtime.js';
    const { BrowserContainer } = (await import(runtimeUrl)) as typeof RuntimeModule;
    const container = await BrowserContainer.boot();
    try {
      await container.mount({
        '/worker.mjs': `
          import { parentPort, workerData } from 'node:worker_threads';
          const view = new Int32Array(workerData.sab);
          Atomics.add(view, 0, workerData.delta);
          parentPort.postMessage({ added: workerData.delta });
        `,
        '/suite.mjs': `
          import zlib from 'node:zlib';
          import crypto from 'node:crypto';
          import { Duplex, Readable, Writable } from 'node:stream';
          import { pipeline } from 'node:stream/promises';
          import { text as streamText } from 'node:stream/consumers';
          import v8 from 'node:v8';
          import { Worker } from 'node:worker_threads';
          import { promisify } from 'node:util';

          const brotliDecompressAsync = promisify(zlib.brotliDecompress);
          const zstdDecompressAsync = promisify(zlib.zstdDecompress);

          // 1. zlib gzip + WASM brotli + WASM zstd
          const sample = 'repeatable-payload-'.repeat(120);
          const gz = zlib.gzipSync(sample);
          const br = zlib.brotliCompressSync(sample);
          const zs = zlib.zstdCompressSync(sample);
          const gzOut = zlib.gunzipSync(gz).toString('utf8');
          const brOut = (await brotliDecompressAsync(br)).toString('utf8');
          const zsOut = (await zstdDecompressAsync(zs)).toString('utf8');

          // 2. crypto (SHA-256, AES-256-GCM, Ed25519, timingSafeEqual)
          const key = crypto.scryptSync('passphrase', 'salt-value', 32);
          const iv = crypto.randomBytes(12);
          const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
          const enc = Buffer.concat([cipher.update('secret-message', 'utf8'), cipher.final()]);
          const tag = cipher.getAuthTag();
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
          decipher.setAuthTag(tag);
          const dec = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');

          const { publicKey, privateKey } = await promisify(crypto.generateKeyPair)('ed25519');
          const sig = await promisify(crypto.sign)(null, Buffer.from('signed-doc'), privateKey);
          const verified = await promisify(crypto.verify)(
            null,
            Buffer.from('signed-doc'),
            publicKey,
            sig,
          );
          const equalOk = crypto.timingSafeEqual(Buffer.from('abcd1234'), Buffer.from('abcd1234'));

          // 3. stream Readable/Writable/Duplex toWeb & fromWeb
          const sinkChunks = [];
          const nodeWritable = new Writable({
            write(chunk, _enc, cb) {
              sinkChunks.push(Buffer.from(chunk).toString('utf8'));
              cb();
            },
          });
          const webWritable = Writable.toWeb(nodeWritable);
          const roundTripWritable = Writable.fromWeb(webWritable);
          const upperDuplex = new Duplex({
            read() {},
            write(chunk, _enc, cb) {
              this.push(Buffer.from(chunk).toString('utf8').toUpperCase());
              cb();
            },
            final(cb) {
              this.push(null);
              cb();
            },
          });
          const webDuplex = Duplex.toWeb(upperDuplex);
          const nodeDuplex = Duplex.fromWeb(webDuplex);
          await pipeline(Readable.from(['hello ', 'streams']), nodeDuplex, roundTripWritable);
          const consumerOut = await streamText(Readable.toWeb(Readable.from(['consumer-ok'])));

          // 4. v8 serializer
          const complex = { map: new Map([['k', 99n]]), set: new Set(['x']), date: new Date(1700000000000) };
          const cloned = v8.deserialize(v8.serialize(complex));

          // 5. worker_threads + SharedArrayBuffer
          const sab = new SharedArrayBuffer(4);
          const sabView = new Int32Array(sab);
          sabView[0] = 10;
          const workerMsg = await new Promise((resolve, reject) => {
            const w = new Worker('/worker.mjs', { workerData: { sab, delta: 32 } });
            w.once('message', resolve);
            w.once('error', reject);
          });

          console.log(JSON.stringify({
            codecsMatch: gzOut === sample && brOut === sample && zsOut === sample,
            compressedSmaller: br.byteLength < sample.length && zs.byteLength < sample.length,
            dec,
            verified,
            equalOk,
            sinkJoined: sinkChunks.join(''),
            consumerOut,
            clonedMapVal: String(cloned.map.get('k')),
            sabTotal: sabView[0],
            workerMsg,
          }));
        `,
      });

      const proc = await container.spawn('node', ['/suite.mjs']);
      return {
        exit: await proc.exit,
        stderr: proc.stderrText,
        stdout: proc.stdoutText.trim(),
      };
    } finally {
      await container.teardown();
    }
  });

  expect(result.stderr).toBe('');
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    codecsMatch: true,
    compressedSmaller: true,
    dec: 'secret-message',
    verified: true,
    equalOk: true,
    sinkJoined: 'HELLO STREAMS',
    consumerOut: 'consumer-ok',
    clonedMapVal: '99',
    sabTotal: 42,
    workerMsg: { added: 32 },
  });
});
