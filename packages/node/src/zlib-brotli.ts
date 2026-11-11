/*!
 * WebAssembly Brotli codec derived from wasm-brotli@2.0.2 and rust-brotli.
 *
 * MIT License
 * Copyright (c) 2019 Dylan Frankland
 * Copyright (c) 2016 Dropbox, Inc. / Brotli Authors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { version as wasmBrotliVersion } from 'wasm-brotli/package.json';
import {
  fetchWasmBytesSync,
  loadWasmModule,
  loadWasmModuleSync,
  readWasmCString,
} from './wasm-loader';
import type {
  CodecStepError,
  CompressionHandle,
  ParsedNumericParams,
  ZlibBase,
  ZlibCodecDeps,
  ZlibDefaultFlush,
} from './zlib';

const BROTLI_DECODE = 8;
const BROTLI_ENCODE = 9;
const BROTLI_OPERATION_PROCESS = 0;
const BROTLI_OPERATION_FLUSH = 1;
const BROTLI_OPERATION_FINISH = 2;
const BROTLI_DECODER_RESULT_ERROR = 0;
const BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT = 2;
const BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS = -13;
const BROTLI_PARAM_LGWIN = 2;
const BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING = 4;
const BROTLI_PARAM_LARGE_WINDOW = 6;
const BROTLI_PARAM_NPOSTFIX = 7;
const BROTLI_PARAM_NDIRECT = 8;
const BROTLI_DECODER_PARAM_LARGE_WINDOW = 1;
const Z_BUF_ERROR = -5;

const MAX_BROTLI_PARAM = BROTLI_PARAM_NDIRECT;
// wasm-brotli@2.0.2's 32-bit Rust encoder supports large windows up to 2^27 (128 MiB);
// LGWIN >= 28 overflows its 32-bit ring-buffer allocation and traps in WASM.
const MAX_WASM_ENCODER_LARGE_LGWIN = 27;

export const BROTLI_WASM_CACHE_KEY = `wasm-brotli@${wasmBrotliVersion}`;

interface BrotliWasmExports {
  memory: WebAssembly.Memory;
  __wbindgen_malloc(size: number): number;
  __wbindgen_free(ptr: number, size: number): void;
  BrotliEncoderCreateInstance(allocFunc: number, freeFunc: number, opaque: number): number;
  BrotliEncoderSetParameter(state: number, param: number, value: number): number;
  BrotliEncoderDestroyInstance(state: number): void;
  BrotliEncoderCompressStream(
    state: number,
    op: number,
    availableInPtr: number,
    nextInPtr: number,
    availableOutPtr: number,
    nextOutPtr: number,
    totalOutPtr: number,
  ): number;
  BrotliDecoderCreateInstance(allocFunc: number, freeFunc: number, opaque: number): number;
  BrotliDecoderSetParameter(state: number, param: number, value: number): void;
  BrotliDecoderDestroyInstance(state: number): void;
  BrotliDecoderDecompressStream(
    state: number,
    availableInPtr: number,
    nextInPtr: number,
    availableOutPtr: number,
    nextOutPtr: number,
    totalOutPtr: number,
  ): number;
  BrotliDecoderGetErrorCode(state: number): number;
  BrotliDecoderErrorString(code: number): number;
}

interface BrotliStateCleanup {
  wasm: BrotliWasmExports;
  mode: number;
  state: number;
}

let sharedExports: BrotliWasmExports | undefined;

const stateRegistry =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<BrotliStateCleanup>(({ wasm, mode, state }) => {
        try {
          if (mode === BROTLI_ENCODE) wasm.BrotliEncoderDestroyInstance(state);
          else wasm.BrotliDecoderDestroyInstance(state);
        } catch {
          // Ignore teardown errors if the WASM instance was already invalidated.
        }
      })
    : undefined;

function instantiateBrotliModule(mod: WebAssembly.Module): BrotliWasmExports {
  if (sharedExports) return sharedExports;
  const instance = new WebAssembly.Instance(mod, {
    './wasm_brotli_browser.js': {
      __wbindgen_string_new: () => 0,
      __wbindgen_rethrow: (err: unknown) => {
        throw err;
      },
    },
  });
  // Safe: wasm-brotli@2.0.2 exports the exact C-ABI functions declared in BrotliWasmExports.
  sharedExports = instance.exports as unknown as BrotliWasmExports;
  return sharedExports;
}

const BROTLI_WASM_URL = new URL('zlib-brotli.wasm', import.meta.url).href;

function ensureBrotliExportsSync(): BrotliWasmExports {
  if (sharedExports) return sharedExports;
  const mod = loadWasmModuleSync(() => fetchWasmBytesSync(BROTLI_WASM_URL), {
    cacheKey: BROTLI_WASM_CACHE_KEY,
  });
  return instantiateBrotliModule(mod);
}

async function ensureBrotliExportsAsync(): Promise<BrotliWasmExports> {
  if (sharedExports) return sharedExports;
  const mod = await loadWasmModule(BROTLI_WASM_URL, { cacheKey: BROTLI_WASM_CACHE_KEY });
  return instantiateBrotliModule(mod);
}

function brotliInvalidParam(key: string): RangeError & { code: string } {
  return Object.assign(new RangeError(`${key} is not a valid Brotli parameter`), {
    code: 'ERR_BROTLI_INVALID_PARAM',
  });
}

function brotliInitFailed(message = 'Initialization failed'): Error & { code: string } {
  return Object.assign(new Error(message), {
    code: 'ERR_ZLIB_INITIALIZATION_FAILED',
  });
}

const BROTLI_DEFAULT_FLUSH: ZlibDefaultFlush = {
  flush: BROTLI_OPERATION_PROCESS,
  finishFlush: BROTLI_OPERATION_FINISH,
  fullFlush: BROTLI_OPERATION_FLUSH,
};

// Apply LARGE_WINDOW (6) before LGWIN (2) so encoder window validation sees the active flag.
const ENCODER_PARAM_ORDER = [6, 0, 1, 2, 3, 4, 5, 7, 8];

export interface BrotliStreamConstructor {
  new (opts?: unknown): ZlibBase;
  (opts?: unknown): ZlibBase;
  prototype: ZlibBase;
}

export function createBrotliClasses(deps: ZlibCodecDeps): {
  BrotliCompress: BrotliStreamConstructor;
  BrotliDecompress: BrotliStreamConstructor;
} {
  const {
    Zlib: ZlibParent,
    WasmCodecHandle,
    asZlibOptions,
    parseNumericParams,
    schedule,
    retain,
    processCallback,
    zlibOnError,
  } = deps;

  class BrotliHandle extends WasmCodecHandle<BrotliWasmExports> {
    #mode: number;
    #paramValues = new Uint32Array(MAX_BROTLI_PARAM + 1);
    #paramPresent = new Uint8Array(MAX_BROTLI_PARAM + 1);
    #writeState: Uint32Array = new Uint32Array(2);
    #wasm: BrotliWasmExports | null = null;
    #state = 0;
    #paramsApplied = false;
    #largeWindowDecode = false;
    #firstByteChecked = false;
    #poisoned = false;

    constructor(mode: number) {
      super('brotli', BROTLI_OPERATION_PROCESS, schedule, retain, zlibOnError);
      this.#mode = mode;
    }

    init(
      parsed: ParsedNumericParams,
      writeState: Uint32Array,
      onWriteComplete: (handle: CompressionHandle) => void,
    ): void {
      this.#writeState = writeState;
      this.bindProcessCallback(onWriteComplete);
      this.#paramValues.set(parsed.values);
      this.#paramPresent.set(parsed.present);

      for (let i = 0; i < parsed.present.length; i++) {
        if (parsed.present[i] === 0) continue;
        const val = parsed.values[i];
        if (this.#mode === BROTLI_ENCODE) {
          if (i === BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING && val !== 0 && val !== 1) {
            throw brotliInitFailed();
          }
        } else if (i > BROTLI_DECODER_PARAM_LARGE_WINDOW) {
          throw brotliInitFailed();
        }
      }

      if (this.#mode === BROTLI_ENCODE) {
        const largeWin =
          parsed.present[BROTLI_PARAM_LARGE_WINDOW] !== 0 &&
          parsed.values[BROTLI_PARAM_LARGE_WINDOW] !== 0;
        const lgwin = parsed.values[BROTLI_PARAM_LGWIN] | 0;
        if (
          largeWin &&
          parsed.present[BROTLI_PARAM_LGWIN] !== 0 &&
          lgwin > MAX_WASM_ENCODER_LARGE_LGWIN
        ) {
          throw brotliInitFailed();
        }
      } else {
        this.#largeWindowDecode =
          parsed.present[BROTLI_DECODER_PARAM_LARGE_WINDOW] !== 0 &&
          parsed.values[BROTLI_DECODER_PARAM_LARGE_WINDOW] !== 0;
      }
    }

    protected override peekWasm(): BrotliWasmExports | undefined {
      return sharedExports;
    }

    protected override getWasmSync(): BrotliWasmExports {
      return ensureBrotliExportsSync();
    }

    protected override getWasmAsync(): Promise<BrotliWasmExports> {
      return ensureBrotliExportsAsync();
    }

    #ensureState(wasm: BrotliWasmExports): number {
      if (this.#poisoned) {
        throw brotliInitFailed();
      }
      if (this.#state !== 0) {
        if (this.#wasm === wasm) return this.#state;
        stateRegistry?.unregister(this);
        this.#state = 0;
        this.#wasm = null;
        this.#poisoned = true;
        throw brotliInitFailed('Brotli stream state was invalidated by a WebAssembly fault');
      }

      this.#wasm = wasm;
      const state =
        (this.#mode === BROTLI_ENCODE
          ? wasm.BrotliEncoderCreateInstance(0, 0, 0)
          : wasm.BrotliDecoderCreateInstance(0, 0, 0)) >>> 0;
      if (!state) {
        throw brotliInitFailed();
      }
      this.#state = state;
      stateRegistry?.register(this, { wasm, mode: this.#mode, state }, this);

      if (!this.#paramsApplied) {
        this.#paramsApplied = true;
        if (this.#mode === BROTLI_ENCODE) {
          for (const i of ENCODER_PARAM_ORDER) {
            if (this.#paramPresent[i] === 0) continue;
            // NPOSTFIX (7) and NDIRECT (8) succeed in Node's C libbrotli; wasm-brotli's
            // Rust C-shim omits those two cases in BrotliEncoderSetParameter.
            if (i === BROTLI_PARAM_NPOSTFIX || i === BROTLI_PARAM_NDIRECT) continue;
            const ok = wasm.BrotliEncoderSetParameter(state, i, this.#paramValues[i]);
            if (!ok) {
              this.destroyNativeState();
              throw brotliInitFailed();
            }
          }
        } else {
          for (let i = 0; i <= BROTLI_DECODER_PARAM_LARGE_WINDOW; i++) {
            if (this.#paramPresent[i] === 0) continue;
            wasm.BrotliDecoderSetParameter(state, i, this.#paramValues[i]);
          }
        }
      }
      return state;
    }

    protected override destroyNativeState(): void {
      if (this.#state !== 0 && this.#wasm) {
        stateRegistry?.unregister(this);
        try {
          if (this.#mode === BROTLI_ENCODE) {
            this.#wasm.BrotliEncoderDestroyInstance(this.#state);
          } else {
            this.#wasm.BrotliDecoderDestroyInstance(this.#state);
          }
        } catch {
          sharedExports = undefined;
        }
        this.#state = 0;
        this.#wasm = null;
      }
      this.#firstByteChecked = false;
    }

    protected override runStep(
      wasm: BrotliWasmExports,
      flush: number,
      input: Uint8Array,
      inOff: number,
      inLen: number,
      out: Uint8Array,
      outOff: number,
      outLen: number,
    ): CodecStepError | undefined {
      const state = this.#ensureState(wasm);

      // In C libbrotli (DecodeWindowBits), bits 0..6 == 0b0010001 (0x11) signal a
      // large-window header, which is rejected immediately unless BROTLI_DECODER_PARAM_LARGE_WINDOW
      // was enabled (rust-brotli accepts large-window headers unconditionally by default).
      if (this.#mode === BROTLI_DECODE && !this.#firstByteChecked && inLen > 0) {
        this.#firstByteChecked = true;
        if (!this.#largeWindowDecode && (input[inOff] & 0x7f) === 0x11) {
          return {
            message: 'Decompression failed',
            code: 'ERR__ERROR_FORMAT_WINDOW_BITS',
            errno: BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS,
          };
        }
      }

      const allocIn = Math.max(inLen, 1);
      const allocOut = Math.max(outLen, 1);
      let scratchPtr = 0;
      let inPtr = 0;
      let outPtr = 0;
      let trapped = false;

      try {
        scratchPtr = wasm.__wbindgen_malloc(20) >>> 0;
        inPtr = wasm.__wbindgen_malloc(allocIn) >>> 0;
        outPtr = wasm.__wbindgen_malloc(allocOut) >>> 0;

        const memBefore = new Uint8Array(wasm.memory.buffer);
        if (inLen > 0) {
          memBefore.set(input.subarray(inOff, inOff + inLen), inPtr);
        }
        const dvBefore = new DataView(wasm.memory.buffer);
        dvBefore.setUint32(scratchPtr, inLen, true);
        dvBefore.setUint32((scratchPtr + 4) >>> 0, inPtr, true);
        dvBefore.setUint32((scratchPtr + 8) >>> 0, outLen, true);
        dvBefore.setUint32((scratchPtr + 12) >>> 0, outPtr, true);
        dvBefore.setUint32((scratchPtr + 16) >>> 0, 0, true);

        let status: number;
        if (this.#mode === BROTLI_ENCODE) {
          status = wasm.BrotliEncoderCompressStream(
            state,
            flush,
            scratchPtr,
            (scratchPtr + 4) >>> 0,
            (scratchPtr + 8) >>> 0,
            (scratchPtr + 12) >>> 0,
            (scratchPtr + 16) >>> 0,
          );
        } else {
          status = wasm.BrotliDecoderDecompressStream(
            state,
            scratchPtr,
            (scratchPtr + 4) >>> 0,
            (scratchPtr + 8) >>> 0,
            (scratchPtr + 12) >>> 0,
            (scratchPtr + 16) >>> 0,
          );
        }

        const dvAfter = new DataView(wasm.memory.buffer);
        const availInAfter = dvAfter.getUint32(scratchPtr, true);
        const availOutAfter = dvAfter.getUint32((scratchPtr + 8) >>> 0, true);
        const produced = outLen - availOutAfter;
        if (produced > 0) {
          const memAfter = new Uint8Array(wasm.memory.buffer);
          out.set(memAfter.subarray(outPtr, (outPtr + produced) >>> 0), outOff);
        }

        this.#writeState[0] = availOutAfter;
        this.#writeState[1] = availInAfter;

        if (this.#mode === BROTLI_ENCODE) {
          if (!status) {
            return {
              message: 'Compression failed',
              code: 'ERR_BROTLI_COMPRESSION_FAILED',
              errno: -1,
            };
          }
          return undefined;
        }

        if (status === BROTLI_DECODER_RESULT_ERROR) {
          const errCode = wasm.BrotliDecoderGetErrorCode(state);
          const rawName = readWasmCString(
            wasm.memory,
            wasm.BrotliDecoderErrorString(errCode) >>> 0,
            'UNKNOWN',
          );
          const code = rawName.startsWith('_') ? `ERR_${rawName}` : `ERR__${rawName}`;
          return {
            message: 'Decompression failed',
            code,
            errno: errCode,
          };
        }

        if (
          flush === BROTLI_OPERATION_FINISH &&
          status === BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT
        ) {
          return {
            message: 'unexpected end of file',
            code: 'Z_BUF_ERROR',
            errno: Z_BUF_ERROR,
          };
        }

        return undefined;
      } catch (err) {
        trapped = true;
        sharedExports = undefined;
        stateRegistry?.unregister(this);
        this.#state = 0;
        this.#wasm = null;
        this.#poisoned = true;
        throw err;
      } finally {
        if (!trapped) {
          if (outPtr) wasm.__wbindgen_free(outPtr, allocOut);
          if (inPtr) wasm.__wbindgen_free(inPtr, allocIn);
          if (scratchPtr) wasm.__wbindgen_free(scratchPtr, 20);
        }
      }
    }

    override reset(): void {
      if (this.#poisoned) throw brotliInitFailed();
      this.destroyNativeState();
      // Node's BrotliEncoderContext::ResetStream / BrotliDecoderContext::ResetStream
      // re-initializes a fresh default C instance without re-applying constructor params.
      this.#paramsApplied = true;
      this.#largeWindowDecode = false;
      this.#firstByteChecked = false;
      if (sharedExports) {
        this.#ensureState(sharedExports);
      }
    }
  }

  class Brotli extends ZlibParent {
    constructor(opts: unknown, mode: number) {
      const options = asZlibOptions(opts);
      const parsed = parseNumericParams(options, MAX_BROTLI_PARAM, brotliInvalidParam);
      const handle = new BrotliHandle(mode);
      const writeState = new Uint32Array(2);
      handle.init(parsed, writeState, processCallback);
      super(options, mode, { handle, defaultFlush: BROTLI_DEFAULT_FLUSH, writeState });
    }
  }

  // Safe: Reflect.construct creates a genuine Brotli/Transform instance whether called with or without `new`.
  const BrotliCompress = function BrotliCompress(this: unknown, opts?: unknown): ZlibBase {
    return Reflect.construct(Brotli, [opts, BROTLI_ENCODE], new.target || BrotliCompress);
  } as unknown as BrotliStreamConstructor;
  Object.setPrototypeOf(BrotliCompress.prototype, Brotli.prototype);
  Object.setPrototypeOf(BrotliCompress, Brotli);

  // Safe: Reflect.construct creates a genuine Brotli/Transform instance whether called with or without `new`.
  const BrotliDecompress = function BrotliDecompress(this: unknown, opts?: unknown): ZlibBase {
    return Reflect.construct(Brotli, [opts, BROTLI_DECODE], new.target || BrotliDecompress);
  } as unknown as BrotliStreamConstructor;
  Object.setPrototypeOf(BrotliDecompress.prototype, Brotli.prototype);
  Object.setPrototypeOf(BrotliDecompress, Brotli);

  return { BrotliCompress, BrotliDecompress };
}
