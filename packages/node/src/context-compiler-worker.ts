import { initialize, transform } from 'esbuild-wasm';
import {
  HEADER_BYTES,
  REPLY_FAILED,
  REPLY_OK,
  REPLY_TOO_LARGE,
  describeBytes,
  isReplyBuffer,
  reserveReply,
} from './context-compiler-buffer';
import { encoder, record } from './protocol';

const ready = initialize({
  wasmURL: new URL('context-esbuild.wasm', import.meta.url).href,
  worker: false,
});
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
self.onmessage = async (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (
    !record(message) ||
    !positive(message.sourceLimit) ||
    !positive(message.outputLimit) ||
    !isReplyBuffer(message.shared, message.outputLimit) ||
    typeof message.source !== 'string' ||
    typeof message.filename !== 'string'
  )
    return;
  const shared = message.shared;
  const header = new Int32Array(shared, 0, 2);
  let status = REPLY_OK;
  let text: string;
  try {
    if (encoder.encode(message.source).length > message.sourceLimit)
      throw new Error(`Context compiler source exceeds ${describeBytes(message.sourceLimit)}`);
    await ready;
    text = (
      await transform(message.source, {
        target: 'es2016',
        // The loader substitutes import.meta; ES2016 would otherwise empty it.
        // String export/import names are module linking syntax the engine
        // handles natively; ES2016 would otherwise reject the module.
        supported: { 'import-meta': true, 'arbitrary-module-namespace-names': true },
        sourcefile: message.filename,
        sourcemap: 'inline',
      })
    ).code;
  } catch (error) {
    status = REPLY_FAILED;
    text = error instanceof Error ? error.message : String(error);
  }
  const output = encoder.encode(text);
  if (output.length > message.outputLimit) {
    // The process reports the bound; only the size travels back.
    status = REPLY_TOO_LARGE;
    Atomics.store(header, 1, Math.min(output.length, 0x7fffffff));
  } else {
    reserveReply(shared, output.length);
    // A view made after growth covers the grown length.
    new Uint8Array(shared, HEADER_BYTES, output.length).set(output);
    Atomics.store(header, 1, output.length);
  }
  Atomics.store(header, 0, status);
  Atomics.notify(header, 0);
};

void ready.then(
  () => self.postMessage('ready'),
  (error) => self.postMessage(String(error)),
);
