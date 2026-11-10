import { Buffer } from 'buffer';
import * as stream from 'readable-stream/lib/stream.js';
import { createStreamConsumers } from '../stream-consumers';
import { installNodeStream } from '../stream-module';

const guestStream = installNodeStream();

export function createStreamBuiltins(
  capture?: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
) {
  // Node binds these two completion callbacks to the context that registered them.
  const bindCompletion = <Fn extends (...args: never[]) => unknown>(fn: Fn) =>
    capture
      ? (...args: unknown[]) => {
          const last = args.length - 1;
          const completion = args[last];
          if (typeof completion === 'function')
            args[last] = capture(completion as (...args: unknown[]) => unknown);
          return Reflect.apply(fn, undefined, args);
        }
      : fn;
  return {
    // Node's lib/stream.js shape (see stream-module.ts); `default` is kept from the
    // earlier namespace object for guests that read it.
    stream: Object.assign(guestStream, {
      default: guestStream,
      finished: bindCompletion(stream.finished),
      pipeline: bindCompletion(stream.pipeline),
    }),
    'stream/promises': stream.promises,
    'stream/consumers': createStreamConsumers(Buffer),
    // Keep Web Streams constructor identity with the process Worker's globals.
    'stream/web': {
      ReadableStream,
      ReadableStreamDefaultReader,
      ReadableStreamBYOBReader,
      ReadableStreamBYOBRequest,
      ReadableByteStreamController,
      ReadableStreamDefaultController,
      TransformStream,
      TransformStreamDefaultController,
      WritableStream,
      WritableStreamDefaultWriter,
      WritableStreamDefaultController,
      ByteLengthQueuingStrategy,
      CountQueuingStrategy,
      TextEncoderStream,
      TextDecoderStream,
      CompressionStream,
      DecompressionStream,
    },
  };
}
