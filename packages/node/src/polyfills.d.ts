// readable-stream 4's full module (lib/stream.js), the userland copy of Node's own
// stream implementation. Its package `browser` entry exports a reduced object, so the
// runtime imports this file directly.
declare module 'readable-stream/lib/stream.js' {
  export {
    Stream,
    Readable,
    Writable,
    Duplex,
    Transform,
    PassThrough,
    pipeline,
    finished,
    addAbortSignal,
    compose,
    destroy,
    isDestroyed,
    isDisturbed,
    isErrored,
    isReadable,
    isWritable,
    getDefaultHighWaterMark,
    setDefaultHighWaterMark,
    promises,
  } from 'node:stream';
}
declare module 'util/' {
  export * from 'node:util';
}
declare module 'process/browser' {
  const process: {
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void;
    env: Record<string, string>;
    cwd: () => string;
  };
  export default process;
}
declare module 'url/' {
  export * from 'node:url';
}
declare module 'querystring-es3' {
  export * from 'node:querystring';
}
declare module 'string_decoder/' {
  export * from 'node:string_decoder';
}
declare module 'statuses' {
  export const message: Record<string, string>;
}
declare module 'libsodium-sumo' {
  // The pinned raw 0.8.4 ESM factory exposes these compiled WASM exports.
  export default function createSodium(options: { getRandomValue: () => number }): Promise<{
    HEAPU8: Uint8Array;
    _malloc(size: number): number;
    _free(pointer: number): void;
    _crypto_verify_32(left: number, right: number): number;
  }>;
}
declare module 'path-browserify-win32' {
  import path from 'node:path';
  export default path;
}
