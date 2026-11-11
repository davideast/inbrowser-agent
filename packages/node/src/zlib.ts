import { Buffer, kMaxLength } from 'buffer';
import {
  ZStream,
  type Z_FlushMode,
  zlibDeflate,
  zlibDeflateEnd,
  zlibDeflateInit2,
  zlibDeflateReset,
  zlibDeflateSetDictionary,
  zlibInflate,
  zlibInflateEnd,
  zlibInflateInit2,
  zlibInflateReset,
  zlibInflateSetDictionary,
} from 'pako';
import browserProcess from 'process/browser';
import { Transform, finished } from 'readable-stream/lib/stream.js';
import { encoder, fault, record } from './protocol';
import { createBrotliClasses } from './zlib-brotli';
import { createZstdClasses } from './zlib-zstd';

// Node 22.18.0's `zlib.constants` (internalBinding('constants').zlib), copied
// value for value. ZLIB_VERNUM is Node's linked zlib 1.3.1; the engine here is
// pako 3.0.1, a JavaScript port of zlib whose deflate output matched Node's
// byte for byte on the tested inputs and levels (tests/zlib-streams.spec.ts).
export const CONSTANTS = {
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2,
  Z_RLE: 3,
  Z_FIXED: 4,
  Z_DEFAULT_STRATEGY: 0,
  ZLIB_VERNUM: 4880,
  DEFLATE: 1,
  INFLATE: 2,
  GZIP: 3,
  GUNZIP: 4,
  DEFLATERAW: 5,
  INFLATERAW: 6,
  UNZIP: 7,
  BROTLI_DECODE: 8,
  BROTLI_ENCODE: 9,
  ZSTD_DECOMPRESS: 11,
  ZSTD_COMPRESS: 10,
  Z_MIN_WINDOWBITS: 8,
  Z_MAX_WINDOWBITS: 15,
  Z_DEFAULT_WINDOWBITS: 15,
  Z_MIN_CHUNK: 64,
  Z_MAX_CHUNK: Number.POSITIVE_INFINITY,
  Z_DEFAULT_CHUNK: 16384,
  Z_MIN_MEMLEVEL: 1,
  Z_MAX_MEMLEVEL: 9,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_MIN_LEVEL: -1,
  Z_MAX_LEVEL: 9,
  Z_DEFAULT_LEVEL: -1,
  BROTLI_OPERATION_PROCESS: 0,
  BROTLI_OPERATION_FLUSH: 1,
  BROTLI_OPERATION_FINISH: 2,
  BROTLI_OPERATION_EMIT_METADATA: 3,
  BROTLI_PARAM_MODE: 0,
  BROTLI_MODE_GENERIC: 0,
  BROTLI_MODE_TEXT: 1,
  BROTLI_MODE_FONT: 2,
  BROTLI_DEFAULT_MODE: 0,
  BROTLI_PARAM_QUALITY: 1,
  BROTLI_MIN_QUALITY: 0,
  BROTLI_MAX_QUALITY: 11,
  BROTLI_DEFAULT_QUALITY: 11,
  BROTLI_PARAM_LGWIN: 2,
  BROTLI_MIN_WINDOW_BITS: 10,
  BROTLI_MAX_WINDOW_BITS: 24,
  BROTLI_LARGE_MAX_WINDOW_BITS: 30,
  BROTLI_DEFAULT_WINDOW: 22,
  BROTLI_PARAM_LGBLOCK: 3,
  BROTLI_MIN_INPUT_BLOCK_BITS: 16,
  BROTLI_MAX_INPUT_BLOCK_BITS: 24,
  BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4,
  BROTLI_PARAM_SIZE_HINT: 5,
  BROTLI_PARAM_LARGE_WINDOW: 6,
  BROTLI_PARAM_NPOSTFIX: 7,
  BROTLI_PARAM_NDIRECT: 8,
  BROTLI_DECODER_RESULT_ERROR: 0,
  BROTLI_DECODER_RESULT_SUCCESS: 1,
  BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2,
  BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0,
  BROTLI_DECODER_PARAM_LARGE_WINDOW: 1,
  BROTLI_DECODER_NO_ERROR: 0,
  BROTLI_DECODER_SUCCESS: 1,
  BROTLI_DECODER_NEEDS_MORE_INPUT: 2,
  BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1,
  BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5,
  BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6,
  BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7,
  BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10,
  BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11,
  BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12,
  BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15,
  BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16,
  BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19,
  BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21,
  BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27,
  BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30,
  BROTLI_DECODER_ERROR_UNREACHABLE: -31,
  ZSTD_e_continue: 0,
  ZSTD_e_flush: 1,
  ZSTD_e_end: 2,
  ZSTD_fast: 1,
  ZSTD_dfast: 2,
  ZSTD_greedy: 3,
  ZSTD_lazy: 4,
  ZSTD_lazy2: 5,
  ZSTD_btlazy2: 6,
  ZSTD_btopt: 7,
  ZSTD_btultra: 8,
  ZSTD_btultra2: 9,
  ZSTD_c_compressionLevel: 100,
  ZSTD_c_windowLog: 101,
  ZSTD_c_hashLog: 102,
  ZSTD_c_chainLog: 103,
  ZSTD_c_searchLog: 104,
  ZSTD_c_minMatch: 105,
  ZSTD_c_targetLength: 106,
  ZSTD_c_strategy: 107,
  ZSTD_c_enableLongDistanceMatching: 160,
  ZSTD_c_ldmHashLog: 161,
  ZSTD_c_ldmMinMatch: 162,
  ZSTD_c_ldmBucketSizeLog: 163,
  ZSTD_c_ldmHashRateLog: 164,
  ZSTD_c_contentSizeFlag: 200,
  ZSTD_c_checksumFlag: 201,
  ZSTD_c_dictIDFlag: 202,
  ZSTD_c_nbWorkers: 400,
  ZSTD_c_jobSize: 401,
  ZSTD_c_overlapLog: 402,
  ZSTD_d_windowLogMax: 100,
  ZSTD_CLEVEL_DEFAULT: 3,
  ZSTD_error_no_error: 0,
  ZSTD_error_GENERIC: 1,
  ZSTD_error_prefix_unknown: 10,
  ZSTD_error_version_unsupported: 12,
  ZSTD_error_frameParameter_unsupported: 14,
  ZSTD_error_frameParameter_windowTooLarge: 16,
  ZSTD_error_corruption_detected: 20,
  ZSTD_error_checksum_wrong: 22,
  ZSTD_error_literals_headerWrong: 24,
  ZSTD_error_dictionary_corrupted: 30,
  ZSTD_error_dictionary_wrong: 32,
  ZSTD_error_dictionaryCreation_failed: 34,
  ZSTD_error_parameter_unsupported: 40,
  ZSTD_error_parameter_combination_unsupported: 41,
  ZSTD_error_parameter_outOfBound: 42,
  ZSTD_error_tableLog_tooLarge: 44,
  ZSTD_error_maxSymbolValue_tooLarge: 46,
  ZSTD_error_maxSymbolValue_tooSmall: 48,
  ZSTD_error_stabilityCondition_notRespected: 50,
  ZSTD_error_stage_wrong: 60,
  ZSTD_error_init_missing: 62,
  ZSTD_error_memory_allocation: 64,
  ZSTD_error_workSpace_tooSmall: 66,
  ZSTD_error_dstSize_tooSmall: 70,
  ZSTD_error_srcSize_wrong: 72,
  ZSTD_error_dstBuffer_null: 74,
  ZSTD_error_noForwardProgress_destFull: 80,
  ZSTD_error_noForwardProgress_inputEmpty: 82,
};

const {
  Z_NO_FLUSH,
  Z_BLOCK,
  Z_PARTIAL_FLUSH,
  Z_SYNC_FLUSH,
  Z_FULL_FLUSH,
  Z_FINISH,
  Z_OK,
  Z_STREAM_END,
  Z_NEED_DICT,
  Z_DATA_ERROR,
  Z_BUF_ERROR,
  DEFLATE,
  INFLATE,
  GZIP,
  GUNZIP,
  DEFLATERAW,
  INFLATERAW,
  UNZIP,
  BROTLI_DECODE,
  BROTLI_ENCODE,
  ZSTD_COMPRESS,
  ZSTD_DECOMPRESS,
  BROTLI_OPERATION_PROCESS,
  BROTLI_OPERATION_EMIT_METADATA,
  ZSTD_e_continue,
  ZSTD_e_end,
  Z_MIN_CHUNK,
  Z_DEFAULT_CHUNK,
  Z_MIN_WINDOWBITS,
  Z_MAX_WINDOWBITS,
  Z_DEFAULT_WINDOWBITS,
  Z_MIN_LEVEL,
  Z_MAX_LEVEL,
  Z_DEFAULT_COMPRESSION,
  Z_MIN_MEMLEVEL,
  Z_MAX_MEMLEVEL,
  Z_DEFAULT_MEMLEVEL,
  Z_DEFAULT_STRATEGY,
  Z_FIXED,
} = CONSTANTS;

const CODES: Record<string, string | number> = {
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
};
for (const key of Object.keys(CODES)) CODES[CODES[key]] = key;

// The default output bound, buffer.kMaxLength as in Node: the guest Buffer's
// own limit (buffer 6.0.3: 2^31 - 1).

// --- Node-shaped argument errors (lib/internal/errors.js) --------------------

function received(value: unknown): string {
  if (value == null) return ` Received ${String(value)}`;
  if (typeof value === 'function') return ` Received function ${value.name}`;
  if (typeof value === 'object')
    return ` Received an instance of ${(value as object).constructor?.name ?? 'Object'}`;
  let shown =
    typeof value === 'string'
      ? `'${value.length > 28 ? value.slice(0, 25) + '...' : value}'`
      : String(value);
  if (typeof value === 'bigint') shown += 'n';
  return ` Received type ${typeof value} (${shown})`;
}

export function invalidArgType(name: string, expected: string, value: unknown) {
  const kind = name.includes('.') ? 'property' : 'argument';
  return Object.assign(
    new TypeError(`The "${name}" ${kind} must be ${expected}.${received(value)}`),
    {
      code: 'ERR_INVALID_ARG_TYPE',
    },
  );
}

export function outOfRange(name: string, range: string, value: unknown) {
  return Object.assign(
    new RangeError(
      `The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`,
    ),
    { code: 'ERR_OUT_OF_RANGE' },
  );
}

function bufferTooLarge(max: number) {
  return Object.assign(new RangeError(`Cannot create a Buffer larger than ${max} bytes`), {
    code: 'ERR_BUFFER_TOO_LARGE',
  });
}

/** Node's checkFiniteNumber: undefined and NaN select the default. */
function finiteNumber(value: unknown, name: string): value is number {
  if (value === undefined) return false;
  if (Number.isFinite(value)) return true;
  if (Number.isNaN(value)) return false;
  if (typeof value !== 'number') throw invalidArgType(name, 'of type number', value);
  throw outOfRange(name, 'a finite number', value);
}

function rangeOrDefault(value: unknown, name: string, lower: number, upper: number, def: number) {
  if (!finiteNumber(value, name)) return def;
  if (value < lower || value > upper) throw outOfRange(name, `>= ${lower} and <= ${upper}`, value);
  return value;
}

let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

export function crc32(data: unknown, value: unknown = 0): number {
  if (typeof data !== 'string' && !ArrayBuffer.isView(data)) {
    throw invalidArgType(
      'data',
      'of type string or an instance of Buffer, TypedArray, or DataView',
      data,
    );
  }

  if (typeof value !== 'number') {
    throw invalidArgType('value', 'of type number', value);
  }
  if (!Number.isInteger(value)) {
    throw outOfRange('value', 'an integer', value);
  }
  if (value < 0 || value > 4294967295) {
    throw outOfRange('value', '>= 0 && <= 4294967295', value);
  }

  let bytes: Uint8Array;
  if (typeof data === 'string') {
    if (data.length === 0) return value >>> 0;
    bytes = encoder.encode(data);
  } else {
    // In Node 22 / C zlib, a detached ArrayBuffer backing store supplies Z_NULL
    // to crc32(crc, Z_NULL, 0), which returns 0 (and DataView.prototype.byteLength
    // throws TypeError if read on a detached buffer).
    if (data.buffer instanceof ArrayBuffer && Reflect.get(data.buffer, 'detached') === true) {
      return 0;
    }
    if (data.byteLength === 0) return value >>> 0;
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  const table = getCrcTable();
  let crc = ~value >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return ~crc >>> 0;
}

// --- The engine handle (Node's ZlibContext in src/node_zlib.cc) ---------------

type Owner = ZlibBase;

export interface CompressionHandle {
  owner?: Owner;
  buffer: Uint8Array | null;
  cb: (() => void) | null;
  availOutBefore: number;
  availInBefore: number;
  inOff: number;
  flushFlag: number;
  writeSync(
    flush: number,
    input: Uint8Array,
    inOff: number,
    inLen: number,
    out: Uint8Array,
    outOff: number,
    outLen: number,
  ): void;
  write(
    flush: number,
    input: Uint8Array,
    inOff: number,
    inLen: number,
    out: Uint8Array,
    outOff: number,
    outLen: number,
  ): void;
  reset(): void;
  close(): void;
}

/**
 * One zlib stream over pako's port of zlib, with the C++ handle's interface:
 * `writeSync` runs now; `write` also runs the work now (on the guest thread,
 * where Node uses its thread pool) and reports from setImmediate, so results
 * and errors arrive asynchronously as they do in Node.
 */
class ZlibHandle implements CompressionHandle {
  owner?: Owner;
  // Set by processChunk() for processCallback(), as on Node's handle object.
  buffer: Uint8Array | null = null;
  cb: (() => void) | null = null;
  availOutBefore = 0;
  availInBefore = 0;
  inOff = 0;
  flushFlag = Z_NO_FLUSH;
  #mode: number;
  #strm = new ZStream();
  #err = Z_OK;
  #flush = Z_NO_FLUSH;
  #dictionary: Uint8Array | undefined;
  #gzipIdBytesRead = 0;
  #writeState: Uint32Array = new Uint32Array(2);
  #processCallback: (handle: CompressionHandle) => void = () => {};
  #writeInProgress = false;
  #pendingClose = false;
  #closed = false;
  #schedule: (callback: () => void) => void;

  constructor(mode: number, schedule: (callback: () => void) => void) {
    this.#mode = mode;
    this.#schedule = schedule;
  }

  init(
    windowBits: number,
    level: number,
    memLevel: number,
    strategy: number,
    writeState: Uint32Array,
    processCallback: (handle: CompressionHandle) => void,
    dictionary: Uint8Array | undefined,
  ) {
    this.#writeState = writeState;
    this.#processCallback = processCallback;
    this.#dictionary =
      dictionary && dictionary.byteLength ? Uint8Array.from(dictionary) : undefined;
    if (this.#mode === GZIP || this.#mode === GUNZIP) windowBits += 16;
    if (this.#mode === UNZIP) windowBits += 32;
    if (this.#mode === DEFLATERAW || this.#mode === INFLATERAW) windowBits *= -1;
    const deflating = this.#mode === DEFLATE || this.#mode === GZIP || this.#mode === DEFLATERAW;
    this.#err = deflating
      ? zlibDeflateInit2(this.#strm, level, 8, windowBits, memLevel, strategy)
      : zlibInflateInit2(this.#strm, windowBits);
    if (this.#err !== Z_OK) {
      this.#mode = 0;
      throw Object.assign(new Error('Init error'), { code: CODES[this.#err], errno: this.#err });
    }
    this.#setDictionary();
  }

  #setDictionary() {
    if (!this.#dictionary) return;
    if (this.#mode === DEFLATE || this.#mode === DEFLATERAW)
      this.#err = zlibDeflateSetDictionary(this.#strm, this.#dictionary);
    else if (this.#mode === INFLATERAW)
      this.#err = zlibInflateSetDictionary(this.#strm, this.#dictionary);
    if (this.#err !== Z_OK) this.#emitError('Failed to set dictionary');
  }

  #setBuffers(
    input: Uint8Array,
    inOff: number,
    inLen: number,
    out: Uint8Array,
    outOff: number,
    outLen: number,
  ) {
    this.#strm.input = input;
    this.#strm.next_in = inOff;
    this.#strm.avail_in = inLen;
    // pako writes through `output.set(..., next_out)`; a Buffer is a Uint8Array.
    this.#strm.output = out as Uint8Array<ArrayBuffer>;
    this.#strm.next_out = outOff;
    this.#strm.avail_out = outLen;
  }

  #inflate() {
    this.#err = zlibInflate(this.#strm, this.#flush as Z_FlushMode);
  }

  /** DoThreadPoolWork. */
  #work() {
    const strm = this.#strm;
    switch (this.#mode) {
      case DEFLATE:
      case GZIP:
      case DEFLATERAW:
        this.#err = zlibDeflate(strm, this.#flush as Z_FlushMode);
        return;
      case UNZIP:
        if (strm.avail_in > 0) {
          let next = strm.next_in;
          if (this.#gzipIdBytesRead === 0) {
            if (strm.input[next] === 0x1f) {
              this.#gzipIdBytesRead = 1;
              next++;
              if (strm.avail_in === 1) break;
            } else {
              this.#mode = INFLATE;
              break;
            }
          }
          if (this.#gzipIdBytesRead === 1) {
            if (strm.input[next] === 0x8b) {
              this.#gzipIdBytesRead = 2;
              this.#mode = GUNZIP;
            } else this.#mode = INFLATE;
          }
        }
        break;
    }
    if (
      this.#mode !== INFLATE &&
      this.#mode !== GUNZIP &&
      this.#mode !== INFLATERAW &&
      this.#mode !== UNZIP
    )
      return;
    this.#inflate();
    if (this.#mode !== INFLATERAW && this.#err === Z_NEED_DICT && this.#dictionary) {
      this.#err = zlibInflateSetDictionary(strm, this.#dictionary);
      if (this.#err === Z_OK) this.#inflate();
      // Tell a bad dictionary from bad input, as Node does.
      else if (this.#err === Z_DATA_ERROR) this.#err = Z_NEED_DICT;
    }
    while (
      strm.avail_in > 0 &&
      this.#mode === GUNZIP &&
      this.#err === Z_STREAM_END &&
      strm.input[strm.next_in] !== 0x00
    ) {
      // More input after a member: another member, or trailing garbage.
      this.#resetStream();
      this.#inflate();
    }
  }

  /** GetErrorInfo: undefined when the status is not an error. */
  #errorMessage(): string | undefined {
    switch (this.#err) {
      case Z_OK:
      case Z_BUF_ERROR:
        if (this.#strm.avail_out !== 0 && this.#flush === Z_FINISH)
          return this.#message('unexpected end of file');
        return undefined;
      case Z_STREAM_END:
        return undefined;
      case Z_NEED_DICT:
        return this.#message(this.#dictionary ? 'Bad dictionary' : 'Missing dictionary');
      default:
        return this.#message('Zlib error');
    }
  }

  #message(fallback: string) {
    return this.#strm.msg || fallback;
  }

  #emitError(message: string) {
    const owner = this.owner;
    this.#writeInProgress = false;
    if (owner) zlibOnError(owner, message, this.#err, String(CODES[this.#err] ?? 'Z_UNKNOWN'));
    if (this.#pendingClose) this.close();
  }

  /** CheckError: reports through the owner and returns false on error. */
  #check() {
    const message = this.#errorMessage();
    if (message === undefined) return true;
    this.#emitError(message);
    return false;
  }

  #updateWriteResult() {
    this.#writeState[0] = this.#strm.avail_out;
    this.#writeState[1] = this.#strm.avail_in;
  }

  #start(
    flush: number,
    input: Uint8Array,
    inOff: number,
    inLen: number,
    out: Uint8Array,
    outOff: number,
    outLen: number,
  ) {
    if (this.#closed || this.#writeInProgress || this.#pendingClose)
      throw fault('EINVAL', 'zlib handle is closed or busy');
    this.#writeInProgress = true;
    this.#setBuffers(input, inOff, inLen, out, outOff, outLen);
    this.#flush = flush;
  }

  writeSync(
    flush: number,
    input: Uint8Array,
    inOff: number,
    inLen: number,
    out: Uint8Array,
    outOff: number,
    outLen: number,
  ) {
    this.#start(flush, input, inOff, inLen, out, outOff, outLen);
    this.#work();
    if (this.#check()) {
      this.#updateWriteResult();
      this.#writeInProgress = false;
    }
  }

  write(
    flush: number,
    input: Uint8Array,
    inOff: number,
    inLen: number,
    out: Uint8Array,
    outOff: number,
    outLen: number,
  ) {
    this.#start(flush, input, inOff, inLen, out, outOff, outLen);
    this.#work();
    this.#schedule(() => {
      this.#writeInProgress = false;
      if (this.#closed) return;
      if (!this.#check()) return;
      this.#updateWriteResult();
      this.#processCallback(this);
      if (this.#pendingClose) this.close();
    });
  }

  #resetStream() {
    this.#err = Z_OK;
    switch (this.#mode) {
      case DEFLATE:
      case DEFLATERAW:
      case GZIP:
        this.#err = zlibDeflateReset(this.#strm);
        break;
      case INFLATE:
      case INFLATERAW:
      case GUNZIP:
        this.#err = zlibInflateReset(this.#strm);
        break;
    }
    if (this.#err !== Z_OK) {
      this.#emitError('Failed to reset stream');
      return;
    }
    this.#setDictionary();
  }

  reset() {
    this.#resetStream();
  }

  close() {
    if (this.#writeInProgress) {
      this.#pendingClose = true;
      return;
    }
    this.#pendingClose = false;
    if (this.#closed) return;
    this.#closed = true;
    if (this.#mode === DEFLATE || this.#mode === GZIP || this.#mode === DEFLATERAW)
      zlibDeflateEnd(this.#strm);
    else if (this.#mode) zlibInflateEnd(this.#strm);
    this.#strm.input = new Uint8Array(0);
    this.#strm.output = new Uint8Array(0);
  }
}

// --- Node's lib/zlib.js ------------------------------------------------------

const kError = Symbol('kError');
const kFlushFlag = Symbol('kFlushFlag');
type FlushBuffer = Buffer & { [kFlushFlag]?: number };

const flushiness: number[] = [];
const kFlushFlagList = [Z_NO_FLUSH, Z_BLOCK, Z_PARTIAL_FLUSH, Z_SYNC_FLUSH, Z_FULL_FLUSH, Z_FINISH];
kFlushFlagList.forEach((flag, index) => (flushiness[flag] = index));
const maxFlush = (a: number, b: number) => (flushiness[a] > flushiness[b] ? a : b);
const kFlushBuffers: FlushBuffer[] = [];
for (const flag of kFlushFlagList) {
  const marker: FlushBuffer = Buffer.from(new ArrayBuffer(0));
  marker[kFlushFlag] = flag;
  kFlushBuffers[flag] = marker;
}

export function zlibOnError(self: ZlibBase, message: string, errno: number, code: string) {
  const error = Object.assign(new Error(message), { errno, code });
  self.destroy(error);
  self[kError] = error;
}

export interface ZlibOptions {
  chunkSize?: unknown;
  flush?: unknown;
  finishFlush?: unknown;
  maxOutputLength?: unknown;
  windowBits?: unknown;
  level?: unknown;
  memLevel?: unknown;
  strategy?: unknown;
  dictionary?: unknown;
  params?: unknown;
  pledgedSrcSize?: unknown;
  info?: unknown;
  encoding?: unknown;
  objectMode?: unknown;
  writableObjectMode?: unknown;
  [key: string]: unknown;
}

export interface ZlibDefaultFlush {
  flush: number;
  finishFlush: number;
  fullFlush: number;
}

const ZLIB_DEFAULT_FLUSH: ZlibDefaultFlush = {
  flush: Z_NO_FLUSH,
  finishFlush: Z_FINISH,
  fullFlush: Z_FULL_FLUSH,
};

function flushBoundsForMode(mode: number): [number, number] {
  if (mode === BROTLI_ENCODE || mode === BROTLI_DECODE) {
    return [BROTLI_OPERATION_PROCESS, BROTLI_OPERATION_EMIT_METADATA];
  }
  if (mode === ZSTD_COMPRESS || mode === ZSTD_DECOMPRESS) {
    return [ZSTD_e_continue, ZSTD_e_end];
  }
  return [Z_NO_FLUSH, Z_BLOCK];
}

interface WritableState {
  ending: boolean;
  finished: boolean;
  length: number;
}

export class ZlibBase extends Transform {
  [kError]: Error | null = null;
  bytesWritten = 0;
  _handle: CompressionHandle | null;
  _outBuffer: Buffer;
  _outOffset = 0;
  _chunkSize: number;
  _defaultFlushFlag: number;
  _finishFlushFlag: number;
  _defaultFullFlushFlag: number;
  _info: unknown;
  _maxOutputLength: number;
  _writeState: Uint32Array;
  _rejectGarbageAfterEnd: boolean;
  declare _writableState: WritableState;
  // Set by the callback convenience methods, as in Node.
  buffers: Buffer[] | null = null;
  nread = 0;
  cb: ((error: Error | null, result?: unknown) => void) | null = null;

  constructor(
    opts: ZlibOptions | undefined,
    mode: number,
    handle: CompressionHandle,
    defaultFlush: ZlibDefaultFlush,
    writeState: Uint32Array,
  ) {
    let chunkSize = Z_DEFAULT_CHUNK;
    let maxOutputLength = kMaxLength;
    let flush = defaultFlush.flush;
    let finishFlush = defaultFlush.finishFlush;
    const [minFlush, maxFlushBound] = flushBoundsForMode(mode);
    if (opts) {
      chunkSize = opts.chunkSize as number;
      if (!finiteNumber(chunkSize, 'options.chunkSize')) chunkSize = Z_DEFAULT_CHUNK;
      else if (chunkSize < Z_MIN_CHUNK)
        throw outOfRange('options.chunkSize', `>= ${Z_MIN_CHUNK}`, chunkSize);
      flush = rangeOrDefault(opts.flush, 'options.flush', minFlush, maxFlushBound, flush);
      finishFlush = rangeOrDefault(
        opts.finishFlush,
        'options.finishFlush',
        minFlush,
        maxFlushBound,
        finishFlush,
      );
      maxOutputLength = rangeOrDefault(
        opts.maxOutputLength,
        'options.maxOutputLength',
        1,
        kMaxLength,
        kMaxLength,
      );
      if (opts.encoding || opts.objectMode || opts.writableObjectMode)
        opts = { ...opts, encoding: null, objectMode: false, writableObjectMode: false };
    }
    super({ autoDestroy: true, ...(opts as object) });
    this._handle = handle;
    handle.owner = this;
    this._writeState = writeState;
    this._outBuffer = Buffer.allocUnsafe(chunkSize);
    this._chunkSize = chunkSize;
    this._defaultFlushFlag = flush;
    this._finishFlushFlag = finishFlush;
    this._defaultFullFlushFlag = defaultFlush.fullFlush;
    this._info = opts?.info;
    this._maxOutputLength = maxOutputLength;
    this._rejectGarbageAfterEnd = opts?.rejectGarbageAfterEnd === true;
  }

  get _closed() {
    return !this._handle;
  }

  reset() {
    if (!this._handle) throw fault('ERR_INTERNAL_ASSERTION', 'zlib binding closed');
    this._handle.reset();
  }

  override _flush(callback: (error?: Error | null) => void) {
    this._transform(Buffer.alloc(0), '', callback);
  }

  // Force Transform compat behavior.
  override _final(callback: (error?: Error | null) => void) {
    callback();
  }

  flush(kind?: unknown, callback?: unknown) {
    if (typeof kind === 'function' || (kind === undefined && !callback)) {
      callback = kind;
      kind = this._defaultFullFlushFlag;
    }
    const done = typeof callback === 'function' ? (callback as () => void) : undefined;
    if (this._writableState.finished) {
      if (done) browserProcess.nextTick(done);
    } else if (this._writableState.ending) {
      if (done) this.once('end', done);
    } else {
      // Node passes an empty encoding with the marker buffer; Buffers ignore it.
      (this.write as (...args: unknown[]) => boolean)(kFlushBuffers[kind as number], '', done);
    }
  }

  close(callback?: (error?: Error | null) => void) {
    if (callback) finished(this, callback);
    this.destroy();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    closeEngine(this);
    callback(error);
  }

  override _transform(chunk: FlushBuffer, _encoding: string, cb: (error?: Error | null) => void) {
    let flushFlag = this._defaultFlushFlag;
    // A zero-length marker chunk carries a flush from the public API.
    if (typeof chunk[kFlushFlag] === 'number') flushFlag = chunk[kFlushFlag];
    // For the last chunk, also apply `_finishFlushFlag`.
    if (this._writableState.ending && this._writableState.length === chunk.byteLength)
      flushFlag = maxFlush(flushFlag, this._finishFlushFlag);
    processChunk(this, chunk, flushFlag, cb);
  }

  _processChunk(chunk: Uint8Array, flushFlag: number, cb?: () => void) {
    if (typeof cb === 'function') processChunk(this, chunk, flushFlag, cb);
    else return processChunkSync(this, chunk, flushFlag);
  }
}

function closeEngine(engine: ZlibBase) {
  engine._handle?.close();
  engine._handle = null;
}

function processChunkSync(self: ZlibBase, chunk: Uint8Array, flushFlag: number) {
  let availInBefore = chunk.byteLength;
  let availOutBefore = self._chunkSize - self._outOffset;
  let inOff = 0;
  let availOutAfter: number;
  let availInAfter: number;
  const buffers: Buffer[] = [];
  let nread = 0;
  let inputRead = 0;
  const state = self._writeState;
  const handle = self._handle;
  let buffer = self._outBuffer;
  let offset = self._outOffset;
  const chunkSize = self._chunkSize;
  let error: unknown;
  self.on('error', (er: unknown) => {
    error = er;
  });
  if (!handle) throw fault('ERR_STREAM_DESTROYED', 'zlib binding closed');
  while (true) {
    handle.writeSync(flushFlag, chunk, inOff, availInBefore, buffer, offset, availOutBefore);
    if (error) throw error;
    if (self[kError]) throw self[kError];
    availOutAfter = state[0];
    availInAfter = state[1];
    const inDelta = availInBefore - availInAfter;
    inputRead += inDelta;
    const have = availOutBefore - availOutAfter;
    if (have > 0) {
      const out = buffer.slice(offset, offset + have);
      offset += have;
      buffers.push(out);
      nread += out.byteLength;
      if (nread > self._maxOutputLength) {
        closeEngine(self);
        throw bufferTooLarge(self._maxOutputLength);
      }
    }
    // Exhausted the output buffer, or used all the input: create a new one.
    if (availOutAfter === 0 || offset >= chunkSize) {
      availOutBefore = chunkSize;
      offset = 0;
      buffer = Buffer.allocUnsafe(chunkSize);
    }
    if (availOutAfter === 0) {
      // Not actually done; reprocess with the remaining input.
      inOff += inDelta;
      availInBefore = availInAfter;
    } else break;
  }
  self.bytesWritten = inputRead;
  closeEngine(self);
  if (nread === 0) return Buffer.alloc(0);
  return buffers.length === 1 ? buffers[0] : Buffer.concat(buffers, nread);
}

function processChunk(self: ZlibBase, chunk: Uint8Array, flushFlag: number, cb: () => void) {
  const handle = self._handle;
  if (!handle) {
    browserProcess.nextTick(cb);
    return;
  }
  handle.buffer = chunk;
  handle.cb = cb;
  handle.availOutBefore = self._chunkSize - self._outOffset;
  handle.availInBefore = chunk.byteLength;
  handle.inOff = 0;
  handle.flushFlag = flushFlag;
  handle.write(
    flushFlag,
    chunk,
    0,
    handle.availInBefore,
    self._outBuffer,
    self._outOffset,
    handle.availOutBefore,
  );
}

export function processCallback(handle: CompressionHandle) {
  const self = handle.owner;
  const done = () => {
    const cb = handle.cb;
    handle.cb = null;
    cb?.();
  };
  if (!self || self.destroyed) {
    handle.buffer = null;
    done();
    return;
  }
  const state = self._writeState;
  const availOutAfter = state[0];
  const availInAfter = state[1];
  const inDelta = handle.availInBefore - availInAfter;
  self.bytesWritten += inDelta;
  const have = handle.availOutBefore - availOutAfter;
  let streamBufferIsFull = false;
  if (have > 0) {
    const out = self._outBuffer.slice(self._outOffset, self._outOffset + have);
    self._outOffset += have;
    streamBufferIsFull = !self.push(out);
  }
  if (self.destroyed) {
    done();
    return;
  }
  // Exhausted the output buffer, or used all the input: create a new one.
  if (availOutAfter === 0 || self._outOffset >= self._chunkSize) {
    handle.availOutBefore = self._chunkSize;
    self._outOffset = 0;
    self._outBuffer = Buffer.allocUnsafe(self._chunkSize);
  }
  if (availOutAfter === 0) {
    // Not actually done; reprocess with the remaining input.
    handle.inOff += inDelta;
    handle.availInBefore = availInAfter;
    const again = () =>
      handle.write(
        handle.flushFlag,
        handle.buffer ?? new Uint8Array(0),
        handle.inOff,
        handle.availInBefore,
        self._outBuffer,
        self._outOffset,
        self._chunkSize,
      );
    if (!streamBufferIsFull) again();
    else {
      const oldRead = self._read;
      self._read = (n: number) => {
        self._read = oldRead;
        again();
        self._read(n);
      };
    }
    return;
  }
  if (availInAfter > 0) {
    // Output space remained, so the engine did not want more input: the
    // compressed stream ended before its input did.
    if (self._rejectGarbageAfterEnd) {
      const error = Object.assign(
        new TypeError('Trailing junk found after the end of the compressed stream'),
        {
          code: 'ERR_TRAILING_JUNK_AFTER_STREAM_END',
        },
      );
      self.destroy(error);
      handle.buffer = null;
      done();
      return;
    }
    self.push(null);
  }
  // Finished with the chunk.
  handle.buffer = null;
  done();
}

export function asZlibOptions(opts: unknown): ZlibOptions | undefined {
  return record(opts) ? opts : undefined;
}

export interface ParsedNumericParams {
  values: Uint32Array;
  present: Uint8Array;
}

export function parseNumericParams(
  opts: ZlibOptions | undefined,
  maxKey: number,
  invalidParamError: (key: string) => Error,
): ParsedNumericParams {
  const values = new Uint32Array(maxKey + 1);
  const present = new Uint8Array(maxKey + 1);
  const rawParams = opts?.params;
  if (rawParams) {
    const box = Object(rawParams);
    for (const origKey of Object.keys(box)) {
      const key = +origKey;
      if (
        Number.isNaN(key) ||
        !Number.isInteger(key) ||
        key < 0 ||
        key > maxKey ||
        present[key] !== 0
      ) {
        throw invalidParamError(origKey);
      }
      const value: unknown = Reflect.get(box, origKey);
      if (typeof value !== 'number' && typeof value !== 'boolean') {
        throw invalidArgType('options.params[key]', 'of type number', value);
      }
      present[key] = 1;
      values[key] = Number(value) >>> 0;
    }
  }
  return { values, present };
}

export interface CodecStepError {
  message: string;
  code: string;
  errno: number;
}

export abstract class WasmCodecHandle<TWasm> implements CompressionHandle {
  owner?: Owner;
  buffer: Uint8Array | null = null;
  cb: (() => void) | null = null;
  availOutBefore = 0;
  availInBefore = 0;
  inOff = 0;
  flushFlag: number;

  #codecLabel: string;
  #schedule: (callback: () => void) => void;
  #retain: () => () => void;
  #onError: typeof zlibOnError;
  #processCallback: (handle: CompressionHandle) => void = () => {};
  #writeInProgress = false;
  #pendingClose = false;
  #closed = false;

  constructor(
    codecLabel: string,
    initialFlushFlag: number,
    schedule: (callback: () => void) => void,
    retain: () => () => void,
    onError: typeof zlibOnError,
  ) {
    this.#codecLabel = codecLabel;
    this.flushFlag = initialFlushFlag;
    this.#schedule = schedule;
    this.#retain = retain;
    this.#onError = onError;
  }

  protected bindProcessCallback(onWriteComplete: (handle: CompressionHandle) => void): void {
    this.#processCallback = onWriteComplete;
  }

  protected abstract peekWasm(): TWasm | undefined;
  protected abstract getWasmSync(): TWasm;
  protected abstract getWasmAsync(): Promise<TWasm>;
  protected abstract destroyNativeState(): void;
  protected abstract runStep(
    wasm: TWasm,
    flush: number,
    input: Uint8Array,
    inOff: number,
    inLen: number,
    out: Uint8Array,
    outOff: number,
    outLen: number,
  ): CodecStepError | undefined;

  #emitStepError(err: CodecStepError): void {
    const owner = this.owner;
    this.#writeInProgress = false;
    if (owner) this.#onError(owner, err.message, err.errno, err.code);
    if (this.#pendingClose) this.close();
  }

  #errorFromThrown(err: unknown): CodecStepError {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof Error && 'code' in err && typeof err.code === 'string'
        ? err.code
        : 'ERR_ZLIB_INITIALIZATION_FAILED';
    return { message, code, errno: -1 };
  }

  #guardStart(): void {
    if (this.#closed || this.#writeInProgress || this.#pendingClose) {
      throw fault('EINVAL', `${this.#codecLabel} handle is closed or busy`);
    }
    this.#writeInProgress = true;
  }

  writeSync(
    flush: number,
    input: Uint8Array,
    inOff: number,
    inLen: number,
    out: Uint8Array,
    outOff: number,
    outLen: number,
  ): void {
    this.#guardStart();
    let stepErr: CodecStepError | undefined;
    try {
      const wasm = this.getWasmSync();
      stepErr = this.runStep(wasm, flush, input, inOff, inLen, out, outOff, outLen);
    } catch (err) {
      this.#writeInProgress = false;
      if (this.#pendingClose) this.close();
      throw err;
    }
    if (stepErr) {
      this.#emitStepError(stepErr);
      return;
    }
    this.#writeInProgress = false;
    if (this.#pendingClose) this.close();
  }

  write(
    flush: number,
    input: Uint8Array,
    inOff: number,
    inLen: number,
    out: Uint8Array,
    outOff: number,
    outLen: number,
  ): void {
    this.#guardStart();
    const finishWithWasm = (wasm: TWasm) => {
      if (this.#closed || this.#pendingClose) {
        this.#writeInProgress = false;
        if (this.#pendingClose) this.close();
        return;
      }
      let stepErr: CodecStepError | undefined;
      let thrownErr: CodecStepError | undefined;
      try {
        stepErr = this.runStep(wasm, flush, input, inOff, inLen, out, outOff, outLen);
      } catch (err) {
        thrownErr = this.#errorFromThrown(err);
      }
      this.#schedule(() => {
        this.#writeInProgress = false;
        if (this.#closed) return;
        const failure = thrownErr ?? stepErr;
        if (failure) {
          this.#emitStepError(failure);
          return;
        }
        this.#processCallback(this);
        if (this.#pendingClose) this.close();
      });
    };

    const warm = this.peekWasm();
    if (warm !== undefined) {
      finishWithWasm(warm);
      return;
    }

    const release = this.#retain();
    this.getWasmAsync().then(
      (wasm) => {
        try {
          finishWithWasm(wasm);
        } finally {
          // Release after finishWithWasm has scheduled the completion callback
          // onto setImmediate so the Worker refcount never hits zero in between.
          release();
        }
      },
      (err: unknown) => {
        try {
          if (this.#closed || this.#pendingClose) {
            this.#writeInProgress = false;
            if (this.#pendingClose) this.close();
            return;
          }
          const failure = this.#errorFromThrown(err);
          this.#schedule(() => {
            this.#writeInProgress = false;
            if (this.#closed) return;
            this.#emitStepError(failure);
          });
        } finally {
          release();
        }
      },
    );
  }

  abstract reset(): void;

  close(): void {
    if (this.#writeInProgress) {
      this.#pendingClose = true;
      return;
    }
    this.#pendingClose = false;
    if (this.#closed) return;
    this.#closed = true;
    this.destroyNativeState();
    this.buffer = null;
    const cb = this.cb;
    this.cb = null;
    cb?.();
  }
}

export interface CustomZlibEngine {
  handle: CompressionHandle;
  defaultFlush: ZlibDefaultFlush;
  writeState: Uint32Array;
}

export type ZlibClass = new (
  opts: unknown,
  mode: number,
  custom?: CustomZlibEngine,
) => ZlibBase & { params(): void };

export interface ZlibCodecDeps {
  Zlib: ZlibClass;
  ZlibBase: typeof ZlibBase;
  WasmCodecHandle: typeof WasmCodecHandle;
  asZlibOptions: typeof asZlibOptions;
  parseNumericParams: typeof parseNumericParams;
  schedule: (callback: () => void) => void;
  retain: () => () => void;
  processCallback: typeof processCallback;
  zlibOnError: typeof zlibOnError;
}

/**
 * The guest-visible zlib module members this runtime implements, matching Node
 * 22.18 across deflate/inflate/gzip/gunzip/unzip, Brotli, Zstd, and crc32.
 * `schedule` must be the guest's setImmediate, and `retain` keeps the guest
 * process alive while lazy Worker WebAssembly modules compile asynchronously.
 */
export function createZlib(
  schedule: (callback: () => void) => void,
  retain: () => () => void = () => () => {},
) {
  function engine(opts: unknown, mode: number) {
    let windowBits = Z_DEFAULT_WINDOWBITS;
    let level = Z_DEFAULT_COMPRESSION;
    let memLevel = Z_DEFAULT_MEMLEVEL;
    let strategy = Z_DEFAULT_STRATEGY;
    let dictionary: Uint8Array | undefined;
    const options = asZlibOptions(opts);
    if (options) {
      // On the decompression side, 0 asks zlib to use the stream header's window.
      if (
        (options.windowBits == null || options.windowBits === 0) &&
        (mode === INFLATE || mode === GUNZIP || mode === UNZIP)
      )
        windowBits = 0;
      else {
        // `{ windowBits: 8 }` is valid for deflate but not gzip.
        const min = Z_MIN_WINDOWBITS + (mode === GZIP ? 1 : 0);
        windowBits = rangeOrDefault(
          options.windowBits,
          'options.windowBits',
          min,
          Z_MAX_WINDOWBITS,
          Z_DEFAULT_WINDOWBITS,
        );
      }
      level = rangeOrDefault(
        options.level,
        'options.level',
        Z_MIN_LEVEL,
        Z_MAX_LEVEL,
        Z_DEFAULT_COMPRESSION,
      );
      memLevel = rangeOrDefault(
        options.memLevel,
        'options.memLevel',
        Z_MIN_MEMLEVEL,
        Z_MAX_MEMLEVEL,
        Z_DEFAULT_MEMLEVEL,
      );
      strategy = rangeOrDefault(
        options.strategy,
        'options.strategy',
        Z_DEFAULT_STRATEGY,
        Z_FIXED,
        Z_DEFAULT_STRATEGY,
      );
      const given = options.dictionary;
      if (given !== undefined) {
        if (ArrayBuffer.isView(given))
          dictionary = new Uint8Array(given.buffer, given.byteOffset, given.byteLength);
        else if (given instanceof ArrayBuffer || given instanceof SharedArrayBuffer)
          dictionary = new Uint8Array(given);
        else
          throw invalidArgType(
            'options.dictionary',
            'an instance of Buffer, TypedArray, DataView, or ArrayBuffer',
            given,
          );
      }
    }
    const handle = new ZlibHandle(mode, schedule);
    const writeState = new Uint32Array(2);
    handle.init(windowBits, level, memLevel, strategy, writeState, processCallback, dictionary);
    return { handle, writeState, options };
  }

  class Zlib extends ZlibBase {
    _level = Z_DEFAULT_COMPRESSION;
    _strategy = Z_DEFAULT_STRATEGY;
    _mode: number;
    constructor(opts: unknown, mode: number, custom?: CustomZlibEngine) {
      if (custom) {
        super(asZlibOptions(opts), mode, custom.handle, custom.defaultFlush, custom.writeState);
        this._mode = mode;
        return;
      }
      const { handle, writeState, options } = engine(opts, mode);
      super(options, mode, handle, ZLIB_DEFAULT_FLUSH, writeState);
      this._level = typeof options?.level === 'number' ? options.level : Z_DEFAULT_COMPRESSION;
      this._strategy =
        typeof options?.strategy === 'number' ? options.strategy : Z_DEFAULT_STRATEGY;
      this._mode = mode;
    }

    // deflateParams is not available in the engine.
    params() {
      throw fault('ENOSYS', 'zlib params() is not supported in the browser runtime');
    }
  }

  class Deflate extends Zlib {
    constructor(opts?: unknown) {
      super(opts, DEFLATE);
    }
  }
  class Inflate extends Zlib {
    constructor(opts?: unknown) {
      super(opts, INFLATE);
    }
  }
  class Gzip extends Zlib {
    constructor(opts?: unknown) {
      super(opts, GZIP);
    }
  }
  class Gunzip extends Zlib {
    constructor(opts?: unknown) {
      super(opts, GUNZIP);
    }
  }
  class DeflateRaw extends Zlib {
    constructor(opts?: unknown) {
      const options = asZlibOptions(opts);
      if (options && options.windowBits === 8) options.windowBits = 9;
      super(options, DEFLATERAW);
    }
  }
  class InflateRaw extends Zlib {
    constructor(opts?: unknown) {
      super(opts, INFLATERAW);
    }
  }

  function zlibBuffer(engine: ZlibBase, buffer: unknown, callback: unknown) {
    if (typeof callback !== 'function')
      throw invalidArgType('callback', 'of type function', callback);
    if (ArrayBuffer.isView(buffer) && !(buffer instanceof Uint8Array))
      buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    else if (buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer)
      buffer = Buffer.from(buffer);
    engine.buffers = null;
    engine.nread = 0;
    engine.cb = callback as (error: Error | null, result?: unknown) => void;
    engine.on('data', function (this: ZlibBase, chunk: Buffer) {
      if (!this.buffers) this.buffers = [chunk];
      else this.buffers.push(chunk);
      this.nread += chunk.length;
      if (this.nread > this._maxOutputLength) {
        this.close();
        this.removeAllListeners('end');
        this.cb?.(bufferTooLarge(this._maxOutputLength));
      }
    });
    engine.on('error', function (this: ZlibBase, error: Error) {
      this.removeAllListeners('end');
      this.cb?.(error);
    });
    engine.on('end', function (this: ZlibBase) {
      const buffers = this.buffers ?? [];
      const result =
        this.nread === 0
          ? Buffer.alloc(0)
          : buffers.length === 1
            ? buffers[0]
            : Buffer.concat(buffers, this.nread);
      this.close();
      if (this._info) this.cb?.(null, { buffer: result, engine: this });
      else this.cb?.(null, result);
    });
    engine.end(buffer);
  }

  function zlibBufferSync(engine: ZlibBase, buffer: unknown) {
    let bytes: Uint8Array;
    if (typeof buffer === 'string') bytes = Buffer.from(buffer);
    else if (ArrayBuffer.isView(buffer))
      bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    else if (buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer)
      bytes = Buffer.from(buffer);
    else
      throw invalidArgType(
        'buffer',
        'of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer',
        buffer,
      );
    const result = processChunkSync(engine, bytes, engine._finishFlushFlag);
    return engine._info ? { buffer: result, engine } : result;
  }

  type Ctor = new (opts?: unknown) => ZlibBase;
  const sync = (ctor: Ctor) => (buffer: unknown, opts?: unknown) =>
    zlibBufferSync(new ctor(opts), buffer);
  const async = (ctor: Ctor) => (buffer: unknown, opts?: unknown, callback?: unknown) => {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    return zlibBuffer(new ctor(opts), buffer, callback);
  };
  const factory = (ctor: Ctor) => (opts?: unknown) => new ctor(opts);

  const codecDeps: ZlibCodecDeps = {
    Zlib,
    ZlibBase,
    WasmCodecHandle,
    asZlibOptions,
    parseNumericParams,
    schedule,
    retain,
    processCallback,
    zlibOnError,
  };
  const { BrotliCompress, BrotliDecompress } = createBrotliClasses(codecDeps);
  const { ZstdCompress, ZstdDecompress } = createZstdClasses(codecDeps);

  const zlib: Record<string, unknown> = {
    crc32,
    Deflate,
    Inflate,
    Gzip,
    Gunzip,
    DeflateRaw,
    InflateRaw,
    BrotliCompress,
    BrotliDecompress,
    ZstdCompress,
    ZstdDecompress,
    deflate: async(Deflate),
    deflateSync: sync(Deflate),
    gzipSync: sync(Gzip),
    deflateRaw: async(DeflateRaw),
    deflateRawSync: sync(DeflateRaw),
    inflate: async(Inflate),
    inflateSync: sync(Inflate),
    gunzip: async(Gunzip),
    gunzipSync: sync(Gunzip),
    inflateRaw: async(InflateRaw),
    inflateRawSync: sync(InflateRaw),
    brotliCompress: async(BrotliCompress),
    brotliCompressSync: sync(BrotliCompress),
    brotliDecompress: async(BrotliDecompress),
    brotliDecompressSync: sync(BrotliDecompress),
    zstdCompress: async(ZstdCompress),
    zstdCompressSync: sync(ZstdCompress),
    zstdDecompress: async(ZstdDecompress),
    zstdDecompressSync: sync(ZstdDecompress),
    createDeflate: factory(Deflate),
    createInflate: factory(Inflate),
    createDeflateRaw: factory(DeflateRaw),
    createInflateRaw: factory(InflateRaw),
    createGzip: factory(Gzip),
    createGunzip: factory(Gunzip),
    createBrotliCompress: factory(BrotliCompress),
    createBrotliDecompress: factory(BrotliDecompress),
    createZstdCompress: factory(ZstdCompress),
    createZstdDecompress: factory(ZstdDecompress),
    constants: { ...CONSTANTS },
    codes: Object.freeze({ ...CODES }),
  };
  // Node's legacy top-level aliases: non-enumerable, read-only, brotli excluded.
  for (const [key, value] of Object.entries(CONSTANTS))
    if (!key.startsWith('BROTLI'))
      Object.defineProperty(zlib, key, { enumerable: false, writable: false, value });
  return zlib;
}
