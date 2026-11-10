import { createGzip } from '../gzip';
import { createUnzipClass } from '../unzip';
import { createZlib } from '../zlib';

export interface ZlibBuiltinDeps {
  retain: () => () => void;
  setImmediate: (callback: () => void) => unknown;
  unzipBytes: number;
}

export function createZlibBuiltin({ retain, setImmediate, unzipBytes }: ZlibBuiltinDeps) {
  // Object.assign keeps the non-enumerable legacy constant aliases. Unzip
  // (minizlib's bounded decoder) and the gzip callback (CompressionStream,
  // bounded by install.gzipBytes and timers.gzipMs) keep their own
  // implementations and resource bounds.
  return Object.assign(createZlib(setImmediate, retain), {
    Unzip: createUnzipClass(retain, unzipBytes),
    gzip: createGzip(retain),
  });
}
