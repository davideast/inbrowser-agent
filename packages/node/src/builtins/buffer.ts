import { Buffer, kMaxLength as bufferMaxLength } from 'buffer';
import type { EventEmitter } from 'events';
import { isAscii, isUtf8 } from '../buffer-checks';
import {
  SlowBuffer,
  atob,
  btoa,
  installBufferStatics,
  resolveObjectURL,
  transcode,
  validateInspectMaxBytes,
} from '../buffer-extras';

export interface BufferBuiltinDeps {
  process?: EventEmitter;
  retain?: () => () => void;
}

const kStringMaxLength = 536870888;

export function createBufferBuiltin(_deps: BufferBuiltinDeps = {}) {
  installBufferStatics();
  let inspectMaxBytes = 50;

  const bufferConstants = {
    MAX_LENGTH: bufferMaxLength,
    MAX_STRING_LENGTH: kStringMaxLength,
  };

  // Match Node 22.18.0's exact enumerable key order and property descriptors.
  const mod = {
    Buffer,
    SlowBuffer,
    transcode,
    isUtf8,
    isAscii,
    // The guest Buffer (buffer 6.0.3) refuses sizes above its kMaxLength,
    // 2^31 - 1; Node 22 reports 2^53 - 1. MAX_STRING_LENGTH is V8's string
    // limit (2^29 - 24), the engine Node and Chromium share.
    kMaxLength: bufferMaxLength,
    kStringMaxLength,
    btoa,
    atob,
    // Invariant: Object.defineProperties below defines constants, INSPECT_MAX_BYTES, Blob, resolveObjectURL, and File.
  } as {
    Buffer: typeof Buffer;
    SlowBuffer: typeof SlowBuffer;
    transcode: typeof transcode;
    isUtf8: typeof isUtf8;
    isAscii: typeof isAscii;
    kMaxLength: number;
    kStringMaxLength: number;
    btoa: typeof btoa;
    atob: typeof atob;
    readonly constants: { MAX_LENGTH: number; MAX_STRING_LENGTH: number };
    INSPECT_MAX_BYTES: number;
    Blob: typeof globalThis.Blob;
    resolveObjectURL: typeof resolveObjectURL;
    File: typeof globalThis.File;
  };

  Object.defineProperties(mod, {
    constants: {
      value: bufferConstants,
      writable: false,
      enumerable: true,
      configurable: false,
    },
    INSPECT_MAX_BYTES: {
      get() {
        return inspectMaxBytes;
      },
      set(val: unknown) {
        inspectMaxBytes = validateInspectMaxBytes(val);
      },
      enumerable: true,
      configurable: true,
    },
    Blob: {
      value: globalThis.Blob,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    resolveObjectURL: {
      value: resolveObjectURL,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    File: {
      value: globalThis.File,
      writable: true,
      enumerable: true,
      configurable: true,
    },
  });

  return mod;
}
