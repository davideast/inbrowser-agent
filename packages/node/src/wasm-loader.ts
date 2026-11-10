import { RuntimeError, errorTaxonomy } from './errors';
import { fault } from './protocol';

export interface WasmRuntimeApi {
  Module?: typeof WebAssembly.Module;
  compile?: (bytes: BufferSource) => Promise<WebAssembly.Module>;
  compileStreaming?: (source: Response | PromiseLike<Response>) => Promise<WebAssembly.Module>;
}

export type WasmBytesSource = ArrayBuffer | ArrayBufferView | SharedArrayBuffer;

export type WasmModuleSource =
  | string
  | URL
  | WasmBytesSource
  | Response
  | PromiseLike<Response>
  | (() => WasmBytesSource | PromiseLike<WasmBytesSource>);

export interface LoadWasmModuleOptions {
  cacheKey?: string;
  fetchImpl?: (input: string | URL) => Promise<Response>;
  webAssembly?: WasmRuntimeApi | null;
}

export interface SyncWasmXhrLike {
  open(method: string, url: string, async: boolean): void;
  get responseType(): unknown;
  set responseType(value: 'arraybuffer');
  send(): void;
  readonly status: number;
  readonly statusText?: string;
  readonly response: unknown;
}

export interface FetchWasmBytesSyncOptions {
  XMLHttpRequestImpl?: (new () => SyncWasmXhrLike) | null;
}

function lookupPrototypeDescriptor(
  proto: object | undefined,
  key: string,
): PropertyDescriptor | undefined {
  let current: object | null = proto ?? null;
  while (current !== null) {
    const desc = Object.getOwnPropertyDescriptor(current, key);
    if (desc) return desc;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

const HostArrayBuffer = globalThis.ArrayBuffer;
const HostIsArrayBufferView = globalThis.ArrayBuffer.isView.bind(globalThis.ArrayBuffer);
const HostSharedArrayBuffer =
  typeof globalThis.SharedArrayBuffer === 'function' ? globalThis.SharedArrayBuffer : undefined;
const HostUint8Array = globalThis.Uint8Array;
const HostURL = globalThis.URL;
const hostUrlHrefGetter = lookupPrototypeDescriptor(HostURL?.prototype, 'href')?.get;

const HostWebAssembly: WasmRuntimeApi | null =
  typeof globalThis.WebAssembly === 'object' && globalThis.WebAssembly !== null
    ? {
        Module: globalThis.WebAssembly.Module,
        compile:
          typeof globalThis.WebAssembly.compile === 'function'
            ? globalThis.WebAssembly.compile.bind(globalThis.WebAssembly)
            : undefined,
        compileStreaming:
          typeof globalThis.WebAssembly.compileStreaming === 'function'
            ? globalThis.WebAssembly.compileStreaming.bind(globalThis.WebAssembly)
            : undefined,
      }
    : null;

const hostFetch: ((input: string | URL) => Promise<Response>) | undefined =
  typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;

const HostResponse = typeof globalThis.Response === 'function' ? globalThis.Response : undefined;
const hostResponseClone =
  HostResponse && typeof HostResponse.prototype.clone === 'function'
    ? HostResponse.prototype.clone
    : undefined;
const hostResponseArrayBuffer =
  HostResponse && typeof HostResponse.prototype.arrayBuffer === 'function'
    ? HostResponse.prototype.arrayBuffer
    : undefined;
const hostResponseOkGetter = lookupPrototypeDescriptor(HostResponse?.prototype, 'ok')?.get;
const hostResponseStatusGetter = lookupPrototypeDescriptor(HostResponse?.prototype, 'status')?.get;
const hostResponseStatusTextGetter = lookupPrototypeDescriptor(
  HostResponse?.prototype,
  'statusText',
)?.get;
const hostResponseBodyGetter = lookupPrototypeDescriptor(HostResponse?.prototype, 'body')?.get;

const HostXMLHttpRequest: (new () => SyncWasmXhrLike) | undefined =
  typeof globalThis.XMLHttpRequest === 'function' ? globalThis.XMLHttpRequest : undefined;
const hostXhrOpen =
  HostXMLHttpRequest && typeof HostXMLHttpRequest.prototype.open === 'function'
    ? HostXMLHttpRequest.prototype.open
    : undefined;
const hostXhrSend =
  HostXMLHttpRequest && typeof HostXMLHttpRequest.prototype.send === 'function'
    ? HostXMLHttpRequest.prototype.send
    : undefined;
const hostXhrResponseTypeSetter = lookupPrototypeDescriptor(
  HostXMLHttpRequest?.prototype,
  'responseType',
)?.set;
const hostXhrStatusGetter = lookupPrototypeDescriptor(HostXMLHttpRequest?.prototype, 'status')?.get;
const hostXhrStatusTextGetter = lookupPrototypeDescriptor(
  HostXMLHttpRequest?.prototype,
  'statusText',
)?.get;
const hostXhrResponseGetter = lookupPrototypeDescriptor(
  HostXMLHttpRequest?.prototype,
  'response',
)?.get;

const compiledModules = new Map<string, WebAssembly.Module>();
const inflightCompilations = new Map<string, Promise<WebAssembly.Module>>();
const keyEpochs = new Map<string, number>();
let cacheEpoch = 0;

/**
 * Reads a NUL-terminated ASCII/UTF-8 diagnostic string from `WebAssembly.Memory`
 * using unsigned 32-bit pointer arithmetic (`ptr >>> 0`).
 */
export function readWasmCString(memory: WebAssembly.Memory, ptr: number, fallback: string): string {
  const start = ptr >>> 0;
  if (start === 0) return fallback;
  const bytes = new HostUint8Array(memory.buffer);
  let end = start;
  while (end < bytes.length && bytes[end] !== 0) end++;
  if (end === start) return fallback;
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function resolveWasmApi(options?: Pick<LoadWasmModuleOptions, 'webAssembly'>): WasmRuntimeApi {
  const api =
    options && 'webAssembly' in options
      ? options.webAssembly
      : (HostWebAssembly ??
        (typeof globalThis.WebAssembly === 'object' ? globalThis.WebAssembly : null));
  if (!api) {
    throw fault('ENOSYS', 'WebAssembly is not supported in this runtime');
  }
  return api;
}

function hasErrorCode(error: Error, code: string): error is Error & { code: string } {
  return 'code' in error && error.code === code;
}

function isCodedFailure(error: unknown, code: string): error is Error & { code: string } {
  if (error instanceof RuntimeError && error.code === code) return true;
  if (error instanceof Error && hasErrorCode(error, code)) {
    return errorTaxonomy(error).kind !== undefined;
  }
  return false;
}

function wrapWasmFailure(error: unknown): Error & { code: string } {
  if (isCodedFailure(error, 'ENOSYS') || isCodedFailure(error, 'EIO')) {
    return error;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return fault('EIO', `Failed to load WebAssembly module: ${reason}`, { kind: 'channel' });
}

function normalizeBytes(input: WasmBytesSource): Uint8Array<ArrayBuffer> {
  if (input instanceof HostArrayBuffer) {
    return new HostUint8Array(input);
  }
  if (HostSharedArrayBuffer !== undefined && input instanceof HostSharedArrayBuffer) {
    const copy = new HostUint8Array(input.byteLength);
    copy.set(new HostUint8Array(input));
    return copy;
  }
  if (HostIsArrayBufferView(input)) {
    if (input.buffer instanceof HostArrayBuffer) {
      return new HostUint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    const copy = new HostUint8Array(input.byteLength);
    copy.set(new HostUint8Array(input.buffer, input.byteOffset, input.byteLength));
    return copy;
  }
  throw fault('EIO', 'Unsupported WebAssembly binary source', { kind: 'channel' });
}

function isResponseLike(value: unknown): value is Response {
  if (HostResponse && value instanceof HostResponse) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    'arrayBuffer' in value &&
    typeof value.arrayBuffer === 'function' &&
    'ok' in value &&
    typeof value.ok === 'boolean'
  );
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function isUrlInstance(value: unknown): value is URL {
  return Boolean(HostURL && value instanceof HostURL);
}

function resolveUrlString(url: URL | string): string {
  if (typeof url === 'string') return url;
  if (isUrlInstance(url) && hostUrlHrefGetter) {
    return String(Reflect.apply(hostUrlHrefGetter, url, []));
  }
  return String(url);
}

function deriveCacheKey(source: WasmModuleSource, explicitKey?: string): string | undefined {
  if (explicitKey !== undefined) return explicitKey;
  if (typeof source === 'string') return source;
  if (isUrlInstance(source)) return resolveUrlString(source);
  return undefined;
}

async function readResponseBytes(
  response: Response,
  isHostInstance: boolean,
): Promise<ArrayBuffer> {
  const raw: unknown =
    isHostInstance && hostResponseArrayBuffer
      ? await Reflect.apply(hostResponseArrayBuffer, response, [])
      : await response.arrayBuffer();
  if (!(raw instanceof HostArrayBuffer)) {
    throw fault('EIO', 'Expected ArrayBuffer response when loading WebAssembly module', {
      kind: 'channel',
    });
  }
  return raw;
}

async function compileResponseWithFallback(
  response: Response,
  wasm: WasmRuntimeApi,
  compile: (bytes: BufferSource) => Promise<WebAssembly.Module>,
): Promise<WebAssembly.Module> {
  const isHostInstance = Boolean(HostResponse && response instanceof HostResponse);
  const ok =
    isHostInstance && hostResponseOkGetter
      ? Boolean(Reflect.apply(hostResponseOkGetter, response, []))
      : response.ok;
  if (!ok) {
    const status =
      isHostInstance && hostResponseStatusGetter
        ? Number(Reflect.apply(hostResponseStatusGetter, response, []))
        : response.status;
    const statusText =
      isHostInstance && hostResponseStatusTextGetter
        ? String(Reflect.apply(hostResponseStatusTextGetter, response, []))
        : response.statusText;
    throw fault('EIO', `Failed to fetch WebAssembly module (${status} ${statusText})`, {
      kind: 'channel',
    });
  }

  if (typeof wasm.compileStreaming === 'function') {
    let fallbackClone: Response | null = null;
    if (isHostInstance && hostResponseClone && HostResponse) {
      const cloned: unknown = Reflect.apply(hostResponseClone, response, []);
      if (cloned instanceof HostResponse) fallbackClone = cloned;
    } else if (typeof response.clone === 'function') {
      fallbackClone = response.clone();
    }
    try {
      const compiled = await wasm.compileStreaming(response);
      if (fallbackClone) {
        const cloneBody: unknown =
          HostResponse && fallbackClone instanceof HostResponse && hostResponseBodyGetter
            ? Reflect.apply(hostResponseBodyGetter, fallbackClone, [])
            : fallbackClone.body;
        if (
          typeof cloneBody === 'object' &&
          cloneBody !== null &&
          'cancel' in cloneBody &&
          typeof cloneBody.cancel === 'function'
        ) {
          void Promise.resolve(Reflect.apply(cloneBody.cancel, cloneBody, [])).catch(() => {});
        }
      }
      return compiled;
    } catch (streamingError) {
      if (!fallbackClone) {
        throw streamingError;
      }
      const bytes = await readResponseBytes(
        fallbackClone,
        Boolean(HostResponse && fallbackClone instanceof HostResponse),
      );
      return compile(new HostUint8Array(bytes));
    }
  }

  const bytes = await readResponseBytes(response, isHostInstance);
  return compile(new HostUint8Array(bytes));
}

async function compileUncached(
  source: WasmModuleSource,
  options?: LoadWasmModuleOptions,
): Promise<WebAssembly.Module> {
  const wasm = resolveWasmApi(options);
  if (typeof wasm.compile !== 'function') {
    throw fault('ENOSYS', 'WebAssembly.compile is not supported in this runtime');
  }
  const compile = wasm.compile.bind(wasm);

  if (typeof source === 'function') {
    const resolved = await source();
    return compile(normalizeBytes(resolved));
  }

  if (typeof source === 'string' || isUrlInstance(source)) {
    const fetchFn =
      options?.fetchImpl ??
      hostFetch ??
      (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
    if (!fetchFn) {
      throw fault('ENOSYS', 'fetch is not available to load WebAssembly module');
    }
    const target = typeof source === 'string' ? source : resolveUrlString(source);
    const response = await fetchFn(target);
    return compileResponseWithFallback(response, wasm, compile);
  }

  if (isResponseLike(source)) {
    return compileResponseWithFallback(source, wasm, compile);
  }

  if (isPromiseLike<Response>(source)) {
    const response = await source;
    return compileResponseWithFallback(response, wasm, compile);
  }

  return compile(normalizeBytes(source));
}

/**
 * Lazily compiles and memoizes a `WebAssembly.Module` per Worker/realm.
 * Concurrent calls sharing a cache key join a single compilation flight; failed
 * compilations evict their entry and reject with a coded `RuntimeError` (`EIO` or `ENOSYS`).
 */
export async function loadWasmModule(
  source: WasmModuleSource,
  options?: LoadWasmModuleOptions,
): Promise<WebAssembly.Module> {
  const key = deriveCacheKey(source, options?.cacheKey);
  if (key !== undefined) {
    const cached = compiledModules.get(key);
    if (cached) return cached;
    const inflight = inflightCompilations.get(key);
    if (inflight) return inflight;
  }

  const startEpoch = cacheEpoch;
  const startKeyEpoch = key !== undefined ? (keyEpochs.get(key) ?? 0) : 0;

  const flight: Promise<WebAssembly.Module> = Promise.resolve().then(async () => {
    try {
      const mod = await compileUncached(source, options);
      if (
        key !== undefined &&
        cacheEpoch === startEpoch &&
        (keyEpochs.get(key) ?? 0) === startKeyEpoch
      ) {
        const existing = compiledModules.get(key);
        if (existing) return existing;
        compiledModules.set(key, mod);
      }
      return mod;
    } catch (error) {
      throw wrapWasmFailure(error);
    } finally {
      if (key !== undefined && inflightCompilations.get(key) === flight) {
        inflightCompilations.delete(key);
      }
    }
  });

  if (key !== undefined) {
    inflightCompilations.set(key, flight);
  }
  return flight;
}

/**
 * Synchronously fetches binary `.wasm` bytes from `url` inside a Dedicated Worker
 * using synchronous `XMLHttpRequest` (`responseType = 'arraybuffer'`).
 * Throws coded `RuntimeError` (`ENOSYS` when synchronous binary XHR is unavailable,
 * `EIO` on non-200 HTTP status, network failure, or malformed payload).
 */
export function fetchWasmBytesSync(
  url: URL | string,
  options?: FetchWasmBytesSyncOptions,
): Uint8Array<ArrayBuffer> {
  const hasExplicitXhr = Boolean(options && 'XMLHttpRequestImpl' in options);
  const XhrCtor = hasExplicitXhr
    ? options?.XMLHttpRequestImpl
    : (HostXMLHttpRequest ??
      (typeof globalThis.XMLHttpRequest === 'function' ? globalThis.XMLHttpRequest : null));
  if (!XhrCtor) {
    throw fault('ENOSYS', 'XMLHttpRequest is not available for synchronous WebAssembly loading');
  }

  const urlString = resolveUrlString(url);
  const useHostIntrinsics =
    !hasExplicitXhr &&
    XhrCtor === HostXMLHttpRequest &&
    Boolean(
      hostXhrOpen &&
        hostXhrSend &&
        hostXhrResponseTypeSetter &&
        hostXhrStatusGetter &&
        hostXhrResponseGetter,
    );

  let xhr: SyncWasmXhrLike;
  try {
    xhr = new XhrCtor();
    if (useHostIntrinsics && hostXhrOpen && hostXhrResponseTypeSetter) {
      Reflect.apply(hostXhrOpen, xhr, ['GET', urlString, false]);
      Reflect.apply(hostXhrResponseTypeSetter, xhr, ['arraybuffer']);
    } else {
      xhr.open('GET', urlString, false);
      xhr.responseType = 'arraybuffer';
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'InvalidAccessError') {
      throw fault(
        'ENOSYS',
        'Synchronous binary XMLHttpRequest is only supported inside Dedicated Workers',
      );
    }
    throw wrapWasmFailure(error);
  }

  try {
    if (useHostIntrinsics && hostXhrSend) {
      Reflect.apply(hostXhrSend, xhr, []);
    } else {
      xhr.send();
    }
  } catch (error) {
    throw wrapWasmFailure(error);
  }

  const status =
    useHostIntrinsics && hostXhrStatusGetter
      ? Number(Reflect.apply(hostXhrStatusGetter, xhr, []))
      : xhr.status;
  const statusText =
    useHostIntrinsics && hostXhrStatusTextGetter
      ? String(Reflect.apply(hostXhrStatusTextGetter, xhr, []))
      : xhr.statusText;

  if (status !== 200) {
    const suffix = statusText ? ` ${statusText}` : '';
    throw fault('EIO', `Failed to fetch WebAssembly module (${status}${suffix})`, {
      kind: 'channel',
    });
  }

  const responsePayload: unknown =
    useHostIntrinsics && hostXhrResponseGetter
      ? Reflect.apply(hostXhrResponseGetter, xhr, [])
      : xhr.response;

  if (!(responsePayload instanceof HostArrayBuffer)) {
    throw fault('EIO', 'Expected ArrayBuffer response when loading WebAssembly module', {
      kind: 'channel',
    });
  }

  return new HostUint8Array(responsePayload);
}

/**
 * Synchronously compiles and memoizes a `WebAssembly.Module` inside a Dedicated Worker,
 * sharing the same per-Worker `cacheKey` map as `loadWasmModule`.
 */
export function loadWasmModuleSync(
  source: WasmBytesSource | (() => WasmBytesSource),
  options?: Pick<LoadWasmModuleOptions, 'cacheKey' | 'webAssembly'>,
): WebAssembly.Module {
  const key = options?.cacheKey;
  if (key !== undefined) {
    const cached = compiledModules.get(key);
    if (cached) return cached;
  }

  try {
    const wasm = resolveWasmApi(options);
    if (typeof wasm.Module !== 'function') {
      throw fault('ENOSYS', 'Synchronous WebAssembly.Module compilation is not supported');
    }
    const raw = typeof source === 'function' ? source() : source;
    const mod = new wasm.Module(normalizeBytes(raw));
    if (key !== undefined) {
      compiledModules.set(key, mod);
    }
    return mod;
  } catch (error) {
    throw wrapWasmFailure(error);
  }
}

export function hasCachedWasmModule(cacheKey: string): boolean {
  return compiledModules.has(cacheKey);
}

export function clearWasmModuleCache(cacheKey?: string): void {
  if (cacheKey !== undefined) {
    compiledModules.delete(cacheKey);
    inflightCompilations.delete(cacheKey);
    keyEpochs.set(cacheKey, (keyEpochs.get(cacheKey) ?? 0) + 1);
    return;
  }
  compiledModules.clear();
  inflightCompilations.clear();
  keyEpochs.clear();
  cacheEpoch += 1;
}
