/*!
 * WebAssembly Zstandard codec derived from @oneidentity/zstd-js@1.0.3 and Zstandard (libzstd).
 *
 * MIT License
 * Copyright (c) 2022 One Identity
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
 *
 * ---
 *
 * BSD License (Zstandard / libzstd)
 * For Zstandard software
 * Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *  * Neither the name Facebook, nor Meta, nor the names of its contributors may
 *    be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import { version as zstdJsVersion } from '@oneidentity/zstd-js/package.json';
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

const ZSTD_COMPRESS = 10;
const ZSTD_DECOMPRESS = 11;
const ZSTD_e_continue = 0;
const ZSTD_e_flush = 1;
const ZSTD_e_end = 2;

const MAX_ZSTD_CPARAM = 402;
const MAX_ZSTD_DPARAM = 100;
const MAX_BUFFERED_PLEDGED_BYTES = 4 * 1024 * 1024;

const ZSTD_MAGIC_NUMBER = 0xfd2fb528;
const ZSTD_MAGIC_SKIPPABLE_START = 0x184d2a50;
const ZSTD_MAGIC_SKIPPABLE_MASK = 0xfffffff0;

const ZSTD_ERROR_NAMES: ReadonlyMap<number, string> = new Map<number, string>([
  [0, 'ZSTD_error_no_error'],
  [1, 'ZSTD_error_GENERIC'],
  [10, 'ZSTD_error_prefix_unknown'],
  [12, 'ZSTD_error_version_unsupported'],
  [14, 'ZSTD_error_frameParameter_unsupported'],
  [16, 'ZSTD_error_frameParameter_windowTooLarge'],
  [20, 'ZSTD_error_corruption_detected'],
  [22, 'ZSTD_error_checksum_wrong'],
  [24, 'ZSTD_error_literals_headerWrong'],
  [30, 'ZSTD_error_dictionary_corrupted'],
  [32, 'ZSTD_error_dictionary_wrong'],
  [34, 'ZSTD_error_dictionaryCreation_failed'],
  [40, 'ZSTD_error_parameter_unsupported'],
  [41, 'ZSTD_error_parameter_combination_unsupported'],
  [42, 'ZSTD_error_parameter_outOfBound'],
  [44, 'ZSTD_error_tableLog_tooLarge'],
  [46, 'ZSTD_error_maxSymbolValue_tooLarge'],
  [48, 'ZSTD_error_maxSymbolValue_tooSmall'],
  [50, 'ZSTD_error_stabilityCondition_notRespected'],
  [60, 'ZSTD_error_stage_wrong'],
  [62, 'ZSTD_error_init_missing'],
  [64, 'ZSTD_error_memory_allocation'],
  [66, 'ZSTD_error_workSpace_tooSmall'],
  [70, 'ZSTD_error_dstSize_tooSmall'],
  [72, 'ZSTD_error_srcSize_wrong'],
  [74, 'ZSTD_error_dstBuffer_null'],
  [80, 'ZSTD_error_noForwardProgress_destFull'],
  [82, 'ZSTD_error_noForwardProgress_inputEmpty'],
]);

export const ZSTD_WASM_CACHE_KEY = `@oneidentity/zstd-js@${zstdJsVersion}`;

interface ZstdWasmExports {
  memory: WebAssembly.Memory;
  __wasm_call_ctors(): void;
  malloc(size: number): number;
  free(ptr: number): void;
  ZSTD_isError(code: number): number;
  ZSTD_getErrorName(code: number): number;
  ZSTD_CCtx_setParameter(cctx: number, param: number, value: number): number;
  ZSTD_createCStream(): number;
  ZSTD_freeCStream(cctx: number): number;
  ZSTD_initCStream(cctx: number, compressionLevel: number): number;
  ZSTD_compressStream2_simpleArgs(
    cctx: number,
    dst: number,
    dstCapacity: number,
    dstPosPtr: number,
    src: number,
    srcSize: number,
    srcPosPtr: number,
    endOp: number,
  ): number;
  ZSTD_createDStream(): number;
  ZSTD_freeDStream(dctx: number): number;
  ZSTD_initDStream(dctx: number): number;
  ZSTD_decompressStream_simpleArgs(
    dctx: number,
    dst: number,
    dstCapacity: number,
    dstPosPtr: number,
    src: number,
    srcSize: number,
    srcPosPtr: number,
  ): number;
}

interface ZstdStateCleanup {
  wasm: ZstdWasmExports;
  mode: number;
  ctx: number;
}

let sharedExports: ZstdWasmExports | undefined;

const ctxRegistry =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<ZstdStateCleanup>(({ wasm, mode, ctx }) => {
        try {
          if (mode === ZSTD_COMPRESS) wasm.ZSTD_freeCStream(ctx);
          else wasm.ZSTD_freeDStream(ctx);
        } catch {
          // Ignore teardown errors if the WASM instance was invalidated.
        }
      })
    : undefined;

function instantiateZstdModule(mod: WebAssembly.Module): ZstdWasmExports {
  if (sharedExports) return sharedExports;
  const holder: { memory?: WebAssembly.Memory } = {};
  const instance = new WebAssembly.Instance(mod, {
    env: {
      emscripten_resize_heap: (rawRequestedSize: number): number => {
        const mem = holder.memory;
        if (!mem) return 0;
        const requestedSize = rawRequestedSize >>> 0;
        const currentBytes = mem.buffer.byteLength;
        if (requestedSize <= currentBytes) return 1;
        const pagesNeeded = Math.ceil((requestedSize - currentBytes) / 65536);
        try {
          mem.grow(pagesNeeded);
          return 1;
        } catch {
          return 0;
        }
      },
      emscripten_memcpy_big: (dest: number, src: number, num: number): void => {
        const mem = holder.memory;
        if (!mem) return;
        new Uint8Array(mem.buffer).copyWithin(dest >>> 0, src >>> 0, (src + num) >>> 0);
      },
      setTempRet0: (): void => {},
    },
  });
  // Safe: @oneidentity/zstd-js@1.0.3 WASM binary exports the exact Emscripten C-ABI in ZstdWasmExports.
  const exports = instance.exports as unknown as ZstdWasmExports;
  holder.memory = exports.memory;
  exports.__wasm_call_ctors();
  sharedExports = exports;
  return exports;
}

const ZSTD_WASM_URL = new URL('zlib-zstd.wasm', import.meta.url).href;

function ensureZstdExportsSync(): ZstdWasmExports {
  if (sharedExports) return sharedExports;
  const mod = loadWasmModuleSync(() => fetchWasmBytesSync(ZSTD_WASM_URL), {
    cacheKey: ZSTD_WASM_CACHE_KEY,
  });
  return instantiateZstdModule(mod);
}

async function ensureZstdExportsAsync(): Promise<ZstdWasmExports> {
  if (sharedExports) return sharedExports;
  const mod = await loadWasmModule(ZSTD_WASM_URL, { cacheKey: ZSTD_WASM_CACHE_KEY });
  return instantiateZstdModule(mod);
}

function zstdInvalidParam(key: string): RangeError & { code: string } {
  return Object.assign(new RangeError(`${key} is not a valid zstd parameter`), {
    code: 'ERR_ZSTD_INVALID_PARAM',
  });
}

function zstdParamSetFailed(): Error & { code: string } {
  return Object.assign(new Error('Setting parameter failed'), {
    code: 'ERR_ZLIB_INITIALIZATION_FAILED',
  });
}

function zstdInitFailed(message = 'Could not initialize zstd instance'): Error & { code: string } {
  return Object.assign(new Error(message), {
    code: 'ERR_ZLIB_INITIALIZATION_FAILED',
  });
}

function isValidZstdCParamValue(key: number, signedVal: number): boolean {
  switch (key) {
    case 100: // ZSTD_c_compressionLevel
      return true;
    case 101: // ZSTD_c_windowLog (64-bit Node allows 0 or [10, 31])
      return signedVal === 0 || (signedVal >= 10 && signedVal <= 31);
    case 102: // ZSTD_c_hashLog
    case 103: // ZSTD_c_chainLog
    case 161: // ZSTD_c_ldmHashLog
      return signedVal === 0 || (signedVal >= 6 && signedVal <= 30);
    case 104: // ZSTD_c_searchLog
      return signedVal >= 0 && signedVal <= 30;
    case 105: // ZSTD_c_minMatch
      return signedVal === 0 || (signedVal >= 3 && signedVal <= 7);
    case 106: // ZSTD_c_targetLength
      return signedVal >= 0 && signedVal <= 131072;
    case 107: // ZSTD_c_strategy
      return signedVal >= 0 && signedVal <= 9;
    case 160: // ZSTD_c_enableLongDistanceMatching
      return signedVal >= 0 && signedVal <= 2;
    case 162: // ZSTD_c_ldmMinMatch
      return signedVal === 0 || (signedVal >= 4 && signedVal <= 4096);
    case 163: // ZSTD_c_ldmBucketSizeLog
      return signedVal >= 0 && signedVal <= 8;
    case 164: // ZSTD_c_ldmHashRateLog
      return signedVal >= 0 && signedVal <= 25;
    case 200: // ZSTD_c_contentSizeFlag
    case 201: // ZSTD_c_checksumFlag
    case 202: // ZSTD_c_dictIDFlag
    case 400: // ZSTD_c_nbWorkers
    case 401: // ZSTD_c_jobSize
    case 402: // ZSTD_c_overlapLog
      return true;
    default:
      return false;
  }
}

function isValidZstdDParamValue(key: number, signedVal: number): boolean {
  if (key !== 100) return false; // ZSTD_d_windowLogMax
  return signedVal === 0 || (signedVal >= 10 && signedVal <= 31);
}

/**
 * Walks Zstd RFC 8878 §3.1.1 3-byte block headers to verify whether a complete
 * compressed frame is already present in `buf[off .. off + len]` (matching
 * `libzstd`'s `ZSTD_findFrameCompressedSize` single-pass shortcut check).
 */
function findCompleteZstdFrameSize(
  buf: Uint8Array,
  off: number,
  len: number,
  headerSize: number,
  hasChecksum: boolean,
): number | 'corrupt' | null {
  let pos = headerSize;
  while (true) {
    if (pos + 3 > len) return null;
    const bh = buf[off + pos] | (buf[off + pos + 1] << 8) | (buf[off + pos + 2] << 16);
    const lastBlock = bh & 1;
    const blockType = (bh >>> 1) & 3;
    const blockSize = bh >>> 3;
    if (blockType === 3) return 'corrupt';
    pos += 3 + (blockType === 1 ? 1 : blockSize);
    if (pos > len) return null;
    if (lastBlock === 1) {
      const total = pos + (hasChecksum ? 4 : 0);
      return total <= len ? total : null;
    }
  }
}

function checkWindowLogMax(
  header: Uint8Array,
  headerLen: number,
  windowLogMax: number,
  outLen: number,
  freshFrameStart: boolean,
  input: Uint8Array,
  inOff: number,
  inLen: number,
): 'need_more' | 'ok' | CodecStepError {
  if (headerLen < 4) return 'need_more';
  const magic = (header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24)) >>> 0;
  if ((magic & ZSTD_MAGIC_SKIPPABLE_MASK) >>> 0 === ZSTD_MAGIC_SKIPPABLE_START) {
    // Skippable frames allocate zero window memory; #headerChecked resets when ret === 0.
    return 'ok';
  }
  if (magic !== ZSTD_MAGIC_NUMBER) {
    // Let libzstd report ZSTD_error_prefix_unknown on corrupt magic.
    return 'ok';
  }
  if (headerLen < 5) return 'need_more';

  const fhd = header[4];
  const singleSegment = ((fhd >>> 5) & 1) === 1;
  const hasChecksum = ((fhd >>> 2) & 1) === 1;
  const dictIdFlag = fhd & 3;
  const dictBytes = dictIdFlag === 3 ? 4 : dictIdFlag;
  const fcsFlag = fhd >>> 6;
  const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag;
  const needed = 5 + (singleSegment ? 0 : 1) + dictBytes + fcsBytes;
  if (headerLen < needed) return 'need_more';

  const maxWin = 2 ** windowLogMax;
  if (!singleSegment) {
    const wd = header[5];
    const exp = wd >>> 3;
    const mant = wd & 7;
    const base = 2 ** (10 + exp);
    const windowSize = base + (base / 8) * mant;
    if (windowSize > maxWin) {
      return {
        message: 'Frame requires too much memory for decoding',
        code: 'ZSTD_error_frameParameter_windowTooLarge',
        errno: 16,
      };
    }
    return 'ok';
  }

  const fcsOff = 5 + dictBytes;
  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  let fcs = 0;
  if (fcsBytes === 1) fcs = header[fcsOff];
  else if (fcsBytes === 2) fcs = dv.getUint16(fcsOff, true) + 256;
  else if (fcsBytes === 4) fcs = dv.getUint32(fcsOff, true);
  else if (fcsBytes === 8) fcs = Number(dv.getBigUint64(fcsOff, true));

  if (fcs <= maxWin) {
    return 'ok';
  }

  // Matching libzstd ZSTD_decompressStream: single-segment frames only bypass
  // window-buffer allocation when the entire compressed frame is present at frame
  // start and fits into the caller's output slice (`fcs <= outLen`).
  const completeFrame =
    freshFrameStart && fcs <= outLen
      ? findCompleteZstdFrameSize(input, inOff, inLen, needed, hasChecksum)
      : null;
  if (completeFrame === null) {
    return {
      message: 'Frame requires too much memory for decoding',
      code: 'ZSTD_error_frameParameter_windowTooLarge',
      errno: 16,
    };
  }
  return 'ok';
}

function concatUint8Arrays(chunks: Uint8Array[], tail: Uint8Array): Uint8Array {
  let total = tail.byteLength;
  for (const ch of chunks) total += ch.byteLength;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const ch of chunks) {
    out.set(ch, pos);
    pos += ch.byteLength;
  }
  if (tail.byteLength > 0) out.set(tail, pos);
  return out;
}

const ZSTD_DEFAULT_FLUSH: ZlibDefaultFlush = {
  flush: ZSTD_e_continue,
  finishFlush: ZSTD_e_end,
  fullFlush: ZSTD_e_flush,
};

export interface ZstdStreamConstructor {
  new (opts?: unknown): ZlibBase;
  prototype: ZlibBase;
}

export function createZstdClasses(deps: ZlibCodecDeps): {
  ZstdCompress: ZstdStreamConstructor;
  ZstdDecompress: ZstdStreamConstructor;
} {
  const {
    ZlibBase: ZlibBaseParent,
    WasmCodecHandle,
    asZlibOptions,
    parseNumericParams,
    schedule,
    retain,
    processCallback,
    zlibOnError,
  } = deps;

  class ZstdHandle extends WasmCodecHandle<ZstdWasmExports> {
    #mode: number;
    #paramValues: Uint32Array;
    #paramPresent: Uint8Array;
    #pledgedSrcSize: number | undefined;
    #windowLogMax = 0;
    #writeState: Uint32Array = new Uint32Array(2);
    #wasm: ZstdWasmExports | null = null;
    #ctx = 0;
    #paramsApplied = false;
    #frameStarted = false;
    #enforcePledged = false;
    #bufferPledged = false;
    #pledgedChunks: Uint8Array[] = [];
    #pendingBuf: Uint8Array | null = null;
    #pendingOff = 0;
    #consumedBytes = 0;
    #headerBuf = new Uint8Array(18);
    #headerLen = 0;
    #headerChecked = false;
    #poisoned = false;

    constructor(mode: number, maxParam: number) {
      super('zstd', ZSTD_e_continue, schedule, retain, zlibOnError);
      this.#mode = mode;
      this.#paramValues = new Uint32Array(maxParam + 1);
      this.#paramPresent = new Uint8Array(maxParam + 1);
    }

    init(
      parsed: ParsedNumericParams,
      pledgedSrcSize: unknown,
      writeState: Uint32Array,
      onWriteComplete: (handle: CompressionHandle) => void,
    ): void {
      this.#writeState = writeState;
      this.bindProcessCallback(onWriteComplete);
      this.#paramValues.set(parsed.values);
      this.#paramPresent.set(parsed.present);

      if (typeof pledgedSrcSize === 'number') {
        const truncated = Number.isNaN(pledgedSrcSize) ? 0 : Math.trunc(pledgedSrcSize);
        if (truncated < 0) {
          throw Object.assign(new TypeError('pledgedSrcSize may not be negative'), {
            code: 'ERR_INVALID_ARG_VALUE',
          });
        }
        this.#pledgedSrcSize = truncated;
      }

      for (let i = 0; i < parsed.present.length; i++) {
        if (parsed.present[i] === 0) continue;
        const signed = parsed.values[i] | 0;
        if (this.#mode === ZSTD_COMPRESS) {
          if (!isValidZstdCParamValue(i, signed)) {
            throw zstdParamSetFailed();
          }
        } else {
          if (!isValidZstdDParamValue(i, signed)) {
            throw zstdParamSetFailed();
          }
          this.#windowLogMax = signed;
        }
      }
    }

    protected override peekWasm(): ZstdWasmExports | undefined {
      return sharedExports;
    }

    protected override getWasmSync(): ZstdWasmExports {
      return ensureZstdExportsSync();
    }

    protected override getWasmAsync(): Promise<ZstdWasmExports> {
      return ensureZstdExportsAsync();
    }

    #ensureCtx(wasm: ZstdWasmExports): number {
      if (this.#poisoned) {
        throw zstdInitFailed();
      }
      if (this.#ctx !== 0) {
        if (this.#wasm === wasm) return this.#ctx;
        ctxRegistry?.unregister(this);
        this.#ctx = 0;
        this.#wasm = null;
        this.#poisoned = true;
        throw zstdInitFailed('Zstd stream state was invalidated by a WebAssembly fault');
      }

      this.#wasm = wasm;
      if (this.#mode === ZSTD_COMPRESS) {
        const cctx = wasm.ZSTD_createCStream() >>> 0;
        if (!cctx) throw zstdInitFailed();
        this.#ctx = cctx;
        ctxRegistry?.register(this, { wasm, mode: this.#mode, ctx: cctx }, this);
        if (!this.#paramsApplied) {
          this.#paramsApplied = true;
          for (let i = 0; i < this.#paramPresent.length; i++) {
            if (this.#paramPresent[i] === 0) continue;
            // Multithreading worker hints (400..402) are valid in Node's multithreaded build
            // and run single-threaded inside the browser Worker.
            if (i >= 400 && i <= 402) continue;
            let signed = this.#paramValues[i] | 0;
            // 32-bit WASM caps ZSTD_WINDOWLOG_MAX at 30 whereas 64-bit Node accepts 31.
            if (i === 101 && signed === 31) signed = 30;
            const res = wasm.ZSTD_CCtx_setParameter(cctx, i, signed);
            if (wasm.ZSTD_isError(res)) {
              this.destroyNativeState();
              throw zstdParamSetFailed();
            }
          }
        }
        return cctx;
      }

      const dctx = wasm.ZSTD_createDStream() >>> 0;
      if (!dctx) throw zstdInitFailed();
      const initRes = wasm.ZSTD_initDStream(dctx);
      if (wasm.ZSTD_isError(initRes)) {
        wasm.ZSTD_freeDStream(dctx);
        throw zstdInitFailed();
      }
      this.#ctx = dctx;
      ctxRegistry?.register(this, { wasm, mode: this.#mode, ctx: dctx }, this);
      this.#paramsApplied = true;
      return dctx;
    }

    protected override destroyNativeState(): void {
      if (this.#ctx !== 0 && this.#wasm) {
        ctxRegistry?.unregister(this);
        try {
          if (this.#mode === ZSTD_COMPRESS) {
            this.#wasm.ZSTD_freeCStream(this.#ctx);
          } else {
            this.#wasm.ZSTD_freeDStream(this.#ctx);
          }
        } catch {
          sharedExports = undefined;
        }
        this.#ctx = 0;
        this.#wasm = null;
      }
      this.#frameStarted = false;
      this.#enforcePledged = false;
      this.#bufferPledged = false;
      this.#pledgedChunks = [];
      this.#pendingBuf = null;
      this.#pendingOff = 0;
      this.#consumedBytes = 0;
      this.#headerLen = 0;
      this.#headerChecked = false;
    }

    #errorFromReturn(wasm: ZstdWasmExports, ret: number): CodecStepError {
      const errCode = -ret | 0;
      const code = ZSTD_ERROR_NAMES.get(errCode) ?? 'ZSTD_error_GENERIC';
      const message = readWasmCString(
        wasm.memory,
        wasm.ZSTD_getErrorName(ret) >>> 0,
        'Unspecified error code',
      );
      return { message, code, errno: errCode };
    }

    protected override runStep(
      wasm: ZstdWasmExports,
      flush: number,
      input: Uint8Array,
      inOff: number,
      inLen: number,
      out: Uint8Array,
      outOff: number,
      outLen: number,
    ): CodecStepError | undefined {
      const ctx = this.#ensureCtx(wasm);

      let activeInput = input;
      let activeOff = inOff;
      let activeLen = inLen;
      let usingPendingBuf = false;

      if (this.#mode === ZSTD_COMPRESS) {
        if (!this.#frameStarted) {
          this.#frameStarted = true;
          this.#consumedBytes = 0;
          // In libzstd ZSTD_compressStream2, calling with ZSTD_e_end at frame init
          // overrides pledgedSrcSize with input.size; streaming steps enforce it.
          this.#enforcePledged = flush !== ZSTD_e_end && this.#pledgedSrcSize !== undefined;
          this.#bufferPledged =
            flush === ZSTD_e_continue &&
            this.#pledgedSrcSize !== undefined &&
            Number.isFinite(this.#pledgedSrcSize) &&
            this.#pledgedSrcSize <= MAX_BUFFERED_PLEDGED_BYTES;
        }

        if (this.#pendingBuf !== null) {
          usingPendingBuf = true;
          activeInput = this.#pendingBuf;
          activeOff = this.#pendingOff;
          activeLen = this.#pendingBuf.byteLength - this.#pendingOff;
        } else {
          if (
            this.#enforcePledged &&
            this.#pledgedSrcSize !== undefined &&
            this.#consumedBytes + inLen > this.#pledgedSrcSize
          ) {
            return {
              message: 'Src size is incorrect',
              code: 'ZSTD_error_srcSize_wrong',
              errno: 72,
            };
          }

          if (this.#bufferPledged) {
            if (flush === ZSTD_e_continue) {
              if (inLen > 0) {
                this.#pledgedChunks.push(input.slice(inOff, inOff + inLen));
                this.#consumedBytes += inLen;
              }
              this.#writeState[0] = outLen;
              this.#writeState[1] = 0;
              return undefined;
            }
            // Transitioning out of ZSTD_e_continue (ZSTD_e_end or ZSTD_e_flush):
            const totalBytes = this.#consumedBytes + inLen;
            if (flush === ZSTD_e_end && totalBytes !== this.#pledgedSrcSize) {
              return {
                message: 'Src size is incorrect',
                code: 'ZSTD_error_srcSize_wrong',
                errno: 72,
              };
            }
            this.#pendingBuf = concatUint8Arrays(
              this.#pledgedChunks,
              input.subarray(inOff, inOff + inLen),
            );
            this.#pledgedChunks = [];
            this.#bufferPledged = false;
            this.#pendingOff = 0;
            this.#consumedBytes = totalBytes;
            usingPendingBuf = true;
            activeInput = this.#pendingBuf;
            activeOff = 0;
            activeLen = this.#pendingBuf.byteLength;
          }
        }
      } else if (this.#windowLogMax > 0 && !this.#headerChecked && inLen > 0) {
        const freshFrameStart = this.#headerLen === 0;
        const toCopy = Math.min(inLen, this.#headerBuf.length - this.#headerLen);
        if (toCopy > 0) {
          this.#headerBuf.set(input.subarray(inOff, inOff + toCopy), this.#headerLen);
          this.#headerLen += toCopy;
        }
        const winCheck = checkWindowLogMax(
          this.#headerBuf,
          this.#headerLen,
          this.#windowLogMax,
          outLen,
          freshFrameStart,
          input,
          inOff,
          inLen,
        );
        if (winCheck === 'ok') {
          this.#headerChecked = true;
        } else if (winCheck !== 'need_more') {
          return winCheck;
        }
      }

      const allocIn = Math.max(activeLen, 1);
      const allocOut = Math.max(outLen, 1);
      let posPtr = 0;
      let inPtr = 0;
      let outPtr = 0;
      let trapped = false;

      try {
        posPtr = wasm.malloc(8) >>> 0;
        inPtr = wasm.malloc(allocIn) >>> 0;
        outPtr = wasm.malloc(allocOut) >>> 0;
        if (!posPtr || !inPtr || !outPtr) {
          return {
            message: 'Allocation error : not enough memory',
            code: 'ZSTD_error_memory_allocation',
            errno: 64,
          };
        }

        if (activeLen > 0) {
          new Uint8Array(wasm.memory.buffer).set(
            activeInput.subarray(activeOff, activeOff + activeLen),
            inPtr,
          );
        }
        const dvBefore = new DataView(wasm.memory.buffer);
        dvBefore.setUint32(posPtr, 0, true); // dstPos
        dvBefore.setUint32((posPtr + 4) >>> 0, 0, true); // srcPos

        let ret: number;
        if (this.#mode === ZSTD_COMPRESS) {
          ret = wasm.ZSTD_compressStream2_simpleArgs(
            ctx,
            outPtr,
            outLen,
            posPtr,
            inPtr,
            activeLen,
            (posPtr + 4) >>> 0,
            flush,
          );
        } else {
          ret = wasm.ZSTD_decompressStream_simpleArgs(
            ctx,
            outPtr,
            outLen,
            posPtr,
            inPtr,
            activeLen,
            (posPtr + 4) >>> 0,
          );
        }

        if (wasm.ZSTD_isError(ret)) {
          return this.#errorFromReturn(wasm, ret);
        }

        const dvAfter = new DataView(wasm.memory.buffer);
        const dstPos = dvAfter.getUint32(posPtr, true);
        const srcPos = dvAfter.getUint32((posPtr + 4) >>> 0, true);
        if (dstPos > 0) {
          const memAfter = new Uint8Array(wasm.memory.buffer);
          out.set(memAfter.subarray(outPtr, (outPtr + dstPos) >>> 0), outOff);
        }

        if (usingPendingBuf && this.#pendingBuf !== null) {
          this.#pendingOff += srcPos;
          const morePending = this.#pendingOff < this.#pendingBuf.byteLength || ret > 0;
          if (!morePending) {
            this.#pendingBuf = null;
            this.#pendingOff = 0;
            if (flush === ZSTD_e_end) {
              this.#frameStarted = false;
              this.#enforcePledged = false;
              this.#consumedBytes = 0;
            }
          }
          // Signal availOutAfter = 0 whenever morePending so processCallback /
          // processChunkSync allocates a fresh output buffer and drains the rest;
          // caller's inLen was already folded into #pendingBuf on entry (availInAfter = 0).
          this.#writeState[0] = morePending ? 0 : outLen - dstPos;
          this.#writeState[1] = 0;
          return undefined;
        }

        const availOutAfter = outLen - dstPos;
        const availInAfter = inLen - srcPos;
        this.#writeState[0] = availOutAfter;
        this.#writeState[1] = availInAfter;

        if (this.#mode === ZSTD_COMPRESS) {
          this.#consumedBytes += srcPos;
          if (flush === ZSTD_e_end && ret === 0 && availInAfter === 0) {
            if (
              this.#enforcePledged &&
              this.#pledgedSrcSize !== undefined &&
              this.#consumedBytes !== this.#pledgedSrcSize
            ) {
              return {
                message: 'Src size is incorrect',
                code: 'ZSTD_error_srcSize_wrong',
                errno: 72,
              };
            }
            this.#frameStarted = false;
            this.#enforcePledged = false;
            this.#consumedBytes = 0;
          }
        } else if (ret === 0) {
          // End of frame (regular Zstd frame or skippable frame): reset header
          // tracking so any subsequent concatenated frame is checked against windowLogMax.
          this.#headerLen = 0;
          this.#headerChecked = false;
        }

        return undefined;
      } catch (err) {
        trapped = true;
        sharedExports = undefined;
        ctxRegistry?.unregister(this);
        this.#ctx = 0;
        this.#wasm = null;
        this.#poisoned = true;
        throw err;
      } finally {
        if (!trapped) {
          if (outPtr) wasm.free(outPtr);
          if (inPtr) wasm.free(inPtr);
          if (posPtr) wasm.free(posPtr);
        }
      }
    }

    override reset(): void {
      if (this.#poisoned) throw zstdInitFailed();
      this.destroyNativeState();
      // Node's ZstdCompressContext::ResetStream / ZstdDecompressContext::ResetStream
      // recreates a fresh CCtx (preserving pledgedSrcSize) / DCtx without re-running SetParameter.
      this.#paramsApplied = true;
      this.#windowLogMax = 0;
      if (sharedExports) {
        this.#ensureCtx(sharedExports);
      }
    }
  }

  class Zstd extends ZlibBaseParent {
    constructor(opts: unknown, mode: number, maxParam: number) {
      const options = asZlibOptions(opts);
      const parsed = parseNumericParams(options, maxParam, zstdInvalidParam);
      const handle = new ZstdHandle(mode, maxParam);
      const writeState = new Uint32Array(2);
      handle.init(parsed, options?.pledgedSrcSize, writeState, processCallback);
      super(options, mode, handle, ZSTD_DEFAULT_FLUSH, writeState);
    }
  }

  class ZstdCompress extends Zstd {
    constructor(opts?: unknown) {
      super(opts, ZSTD_COMPRESS, MAX_ZSTD_CPARAM);
    }
  }

  class ZstdDecompress extends Zstd {
    constructor(opts?: unknown) {
      super(opts, ZSTD_DECOMPRESS, MAX_ZSTD_DPARAM);
    }
  }

  return { ZstdCompress, ZstdDecompress };
}
