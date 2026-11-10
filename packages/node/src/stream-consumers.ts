// node:stream/consumers, ported from Node.js v22.18.0 lib/stream/consumers.js
// (Copyright Joyent, Inc. and other Node contributors, MIT license). Changes: the
// guest Buffer is injected, and the argument checks Node gets from its own
// TextDecoder, from web streams and from the `for await` source text are raised
// explicitly so the guest sees Node's errors rather than Chromium's.
import { nodeError } from './node-errors';

interface BufferClass {
  from(value: ArrayBuffer): unknown;
}

type Source = AsyncIterable<unknown> | Iterable<unknown>;

// V8 words a failed `for await` after the source text of the operand, and the
// bundler renames the operand, so the non-iterable cases are decided here. A
// null or undefined operand is left to the engine, whose message names no variable.
function iterate(stream: unknown): Source {
  if (stream == null) return stream as never;
  if (
    typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function' &&
    typeof (stream as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function'
  )
    throw new TypeError('stream is not async iterable');
  if (typeof ReadableStream === 'function' && stream instanceof ReadableStream && stream.locked)
    throw nodeError(TypeError, 'ERR_INVALID_STATE', 'Invalid state: ReadableStream is locked');
  return stream as Source;
}

function decodable(chunk: unknown): chunk is BufferSource {
  return (
    chunk instanceof ArrayBuffer ||
    ArrayBuffer.isView(chunk) ||
    (typeof SharedArrayBuffer === 'function' && chunk instanceof SharedArrayBuffer)
  );
}

/** The Blob read in `arrayBuffer()` holds the process itself (native-read-retention.ts). */
export function createStreamConsumers(Buffer: BufferClass) {
  async function blob(stream: unknown): Promise<Blob> {
    const chunks: unknown[] = [];
    for await (const chunk of iterate(stream)) chunks.push(chunk);
    return new Blob(chunks as BlobPart[]);
  }

  async function arrayBuffer(stream: unknown): Promise<ArrayBuffer> {
    const ret = await blob(stream);
    return ret.arrayBuffer();
  }

  async function buffer(stream: unknown): Promise<unknown> {
    return Buffer.from(await arrayBuffer(stream));
  }

  async function text(stream: unknown): Promise<string> {
    const decoder = new TextDecoder();
    let str = '';
    for await (const chunk of iterate(stream)) {
      if (typeof chunk === 'string') {
        str += chunk;
      } else {
        if (!decodable(chunk))
          throw nodeError(
            TypeError,
            'ERR_INVALID_ARG_TYPE',
            'The "input" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView.',
          );
        str += decoder.decode(chunk, { stream: true });
      }
    }
    // Flush the streaming decoder so a pending incomplete multibyte character is handled.
    str += decoder.decode(undefined, { stream: false });
    return str;
  }

  async function json(stream: unknown): Promise<unknown> {
    const str = await text(stream);
    return JSON.parse(str);
  }

  return { arrayBuffer, blob, buffer, text, json };
}
