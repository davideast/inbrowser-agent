import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createSqliteBuiltin } from '../../src/builtins/sqlite';
import { ChannelError, RuntimeError, UnsupportedError } from '../../src/errors';
import { SQLITE_WASM_CACHE_KEY } from '../../src/sqlite';
import * as wasmLoaderNamespace from '../../src/wasm-loader';
import {
  clearWasmModuleCache,
  fetchWasmBytesSync,
  hasCachedWasmModule,
  loadWasmModule,
  loadWasmModuleSync,
  readWasmCString,
} from '../../src/wasm-loader';
import { createZlib } from '../../src/zlib';
import { BROTLI_WASM_CACHE_KEY } from '../../src/zlib-brotli';
import { ZSTD_WASM_CACHE_KEY } from '../../src/zlib-zstd';

// Minimal valid WebAssembly binary: magic `\0asm` + version `1`.
const MINIMAL_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

// Invalid WebAssembly binary (corrupt magic).
const INVALID_WASM = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x00, 0x00, 0x00]);

const req = createRequire(import.meta.url);
const pkgRoot = fileURLToPath(new URL('../..', import.meta.url));

function readSidecarWasmBytes(basename: string): ArrayBuffer {
  const distPath = path.join(pkgRoot, 'dist', basename);
  let buf: Buffer;
  if (existsSync(distPath)) {
    buf = readFileSync(distPath);
  } else if (basename === 'zlib-brotli.wasm') {
    buf = readFileSync(req.resolve('wasm-brotli/wasm_brotli_browser_bg.wasm'));
  } else if (basename === 'sqlite.wasm') {
    buf = readFileSync(req.resolve('node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm'));
  } else if (basename === 'zlib-zstd.wasm') {
    const bundle = readFileSync(req.resolve('@oneidentity/zstd-js/wasm/index.js'), 'utf8');
    const match = /data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/.exec(bundle);
    if (!match?.[1]) throw new Error('Missing zstd base64 payload');
    buf = Buffer.from(match[1], 'base64');
  } else {
    throw new Error(`Unknown sidecar WASM basename: ${basename}`);
  }
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return copy.buffer;
}

function withSidecarSyncXhrStub<T>(run: (requestedBasenames: string[]) => T): T {
  const requestedBasenames: string[] = [];

  class SidecarSyncXhr {
    responseType: '' | 'arraybuffer' = '';
    status = 0;
    statusText = '';
    response: unknown = null;
    private targetUrl = '';

    open(_method: string, url: string): void {
      this.targetUrl = url;
    }

    send(): void {
      const basename = path.posix.basename(new URL(this.targetUrl).pathname);
      requestedBasenames.push(basename);
      this.response = readSidecarWasmBytes(basename);
      this.status = 200;
      this.statusText = 'OK';
    }
  }

  vi.stubGlobal('XMLHttpRequest', SidecarSyncXhr);
  try {
    return run(requestedBasenames);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('wasm-loader', () => {
  it('performs zero compilation until loadWasmModule or loadWasmModuleSync is called', async () => {
    clearWasmModuleCache();
    expect(hasCachedWasmModule('cold-check')).toBe(false);

    let factoryCalls = 0;
    const lazySource = () => {
      factoryCalls += 1;
      return MINIMAL_WASM;
    };

    expect(factoryCalls).toBe(0);
    const mod = await loadWasmModule(lazySource, { cacheKey: 'cold-check' });
    expect(mod).toBeInstanceOf(WebAssembly.Module);
    expect(factoryCalls).toBe(1);
    expect(hasCachedWasmModule('cold-check')).toBe(true);

    // Subsequent async and sync calls hit the cache without re-invoking lazySource.
    const mod2 = await loadWasmModule(lazySource, { cacheKey: 'cold-check' });
    const mod3 = loadWasmModuleSync(lazySource, { cacheKey: 'cold-check' });
    expect(mod2).toBe(mod);
    expect(mod3).toBe(mod);
    expect(factoryCalls).toBe(1);
  });

  it('uses WebAssembly.compileStreaming when available for URL sources and caches single-flight', async () => {
    clearWasmModuleCache();
    let fetchCount = 0;
    let streamingCount = 0;

    let releaseCompile!: (mod: WebAssembly.Module) => void;
    const gate = new Promise<WebAssembly.Module>((resolve) => {
      releaseCompile = resolve;
    });

    const fetchImpl = vi.fn(async () => {
      fetchCount += 1;
      return new Response(MINIMAL_WASM, {
        status: 200,
        headers: { 'content-type': 'application/wasm' },
      });
    });

    const compileStreaming = vi.fn(async () => {
      streamingCount += 1;
      return gate;
    });
    const compile = vi.fn(async (bytes: BufferSource) => WebAssembly.compile(bytes));

    const first = loadWasmModule('https://example.test/codec.wasm', {
      fetchImpl,
      webAssembly: { Module: WebAssembly.Module, compile, compileStreaming },
    });
    const second = loadWasmModule(new URL('https://example.test/codec.wasm'), {
      fetchImpl,
      webAssembly: { Module: WebAssembly.Module, compile, compileStreaming },
    });

    const realModule = await WebAssembly.compile(MINIMAL_WASM);
    releaseCompile(realModule);

    const [m1, m2] = await Promise.all([first, second]);
    expect(m1).toBe(realModule);
    expect(m2).toBe(realModule);
    expect(fetchCount).toBe(1);
    expect(streamingCount).toBe(1);
    expect(compile).not.toHaveBeenCalled();
  });

  it('falls back cleanly to ArrayBuffer + WebAssembly.compile when compileStreaming rejects', async () => {
    clearWasmModuleCache();
    const fetchImpl = vi.fn(
      async () =>
        new Response(MINIMAL_WASM, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
    );
    const compileStreaming = vi.fn(async () => {
      throw new TypeError('Failed to execute compileStreaming: Incorrect response MIME type');
    });
    const compile = vi.fn((bytes: BufferSource) => WebAssembly.compile(bytes));

    const mod = await loadWasmModule('https://example.test/fallback.wasm', {
      fetchImpl,
      webAssembly: { Module: WebAssembly.Module, compile, compileStreaming },
    });

    expect(mod).toBeInstanceOf(WebAssembly.Module);
    expect(compileStreaming).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('handles Uint8Array subviews with non-zero byteOffset and SharedArrayBuffer views', async () => {
    clearWasmModuleCache();
    const padded = new Uint8Array(16);
    padded.fill(0xff);
    padded.set(MINIMAL_WASM, 4);
    const subview = padded.subarray(4, 4 + MINIMAL_WASM.byteLength);

    const asyncMod = await loadWasmModule(subview);
    expect(asyncMod).toBeInstanceOf(WebAssembly.Module);

    const shared = new SharedArrayBuffer(16);
    const sharedBytes = new Uint8Array(shared);
    sharedBytes.fill(0xaa);
    sharedBytes.set(MINIMAL_WASM, 3);
    const sharedView = sharedBytes.subarray(3, 3 + MINIMAL_WASM.byteLength);

    const syncMod = loadWasmModuleSync(sharedView, { cacheKey: 'shared-view-sync' });
    expect(syncMod).toBeInstanceOf(WebAssembly.Module);
    expect(await loadWasmModule(sharedView, { cacheKey: 'shared-view-sync' })).toBe(syncMod);
  });

  it('evicts failed compilations and wraps fetch/compile failures in EIO RuntimeError', async () => {
    clearWasmModuleCache();

    await expect(loadWasmModule(INVALID_WASM, { cacheKey: 'bad-wasm' })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RuntimeError &&
        err instanceof ChannelError &&
        err.code === 'EIO' &&
        err.message.includes('WebAssembly'),
    );
    expect(hasCachedWasmModule('bad-wasm')).toBe(false);

    // Retry under the same cacheKey succeeds once valid bytes are supplied.
    const recovered = await loadWasmModule(MINIMAL_WASM, { cacheKey: 'bad-wasm' });
    expect(recovered).toBeInstanceOf(WebAssembly.Module);
    expect(hasCachedWasmModule('bad-wasm')).toBe(true);

    // HTTP 404 fetch failure also surfaces as EIO RuntimeError.
    const fetch404 = vi.fn(
      async () => new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );
    await expect(
      loadWasmModule('https://example.test/missing.wasm', { fetchImpl: fetch404 }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RuntimeError && err.code === 'EIO' && err.message.includes('404'),
    );

    // Synchronous compile failure also surfaces as EIO RuntimeError and does not poison the cache.
    expect(() => loadWasmModuleSync(INVALID_WASM, { cacheKey: 'bad-sync' })).toThrowError(
      expect.objectContaining({ code: 'EIO' }),
    );
    expect(hasCachedWasmModule('bad-sync')).toBe(false);
  });

  it('raises ENOSYS UnsupportedError when WebAssembly support is unavailable', async () => {
    clearWasmModuleCache();

    await expect(loadWasmModule(MINIMAL_WASM, { webAssembly: null })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RuntimeError && err instanceof UnsupportedError && err.code === 'ENOSYS',
    );

    expect(() => loadWasmModuleSync(MINIMAL_WASM, { webAssembly: null })).toThrowError(
      expect.objectContaining({ code: 'ENOSYS' }),
    );
  });

  it('supports Response/Promise<Response> inputs without compileStreaming and omits dead decodeBase64Wasm export', async () => {
    clearWasmModuleCache();
    expect('decodeBase64Wasm' in wasmLoaderNamespace).toBe(false);

    const mod = await loadWasmModule(Promise.resolve(new Response(MINIMAL_WASM, { status: 200 })), {
      cacheKey: 'response-no-streaming',
      webAssembly: {
        Module: WebAssembly.Module,
        compile: (bytes: BufferSource) => WebAssembly.compile(bytes),
      },
    });
    expect(mod).toBeInstanceOf(WebAssembly.Module);
  });

  it('captures HostXMLHttpRequest, HostWebAssembly, HostResponse, and HostArrayBuffer intrinsics against prototype tampering', async () => {
    vi.resetModules();

    const xhrState = new WeakMap<
      object,
      { url: string; responseType: string; status: number; statusText: string; response: unknown }
    >();

    class HostWorkerXhr {}
    Object.defineProperties(HostWorkerXhr.prototype, {
      open: {
        configurable: true,
        writable: true,
        value(this: object, _method: string, url: string) {
          xhrState.set(this, {
            url,
            responseType: '',
            status: 0,
            statusText: '',
            response: null,
          });
        },
      },
      responseType: {
        configurable: true,
        get(this: object) {
          return xhrState.get(this)?.responseType ?? '';
        },
        set(this: object, value: string) {
          const st = xhrState.get(this);
          if (st) st.responseType = value;
        },
      },
      send: {
        configurable: true,
        writable: true,
        value(this: object) {
          const st = xhrState.get(this);
          if (!st) throw new Error('missing state');
          const copy = new Uint8Array(MINIMAL_WASM.byteLength);
          copy.set(MINIMAL_WASM);
          st.status = 200;
          st.statusText = 'OK';
          st.response = copy.buffer;
        },
      },
      status: {
        configurable: true,
        get(this: object) {
          return xhrState.get(this)?.status ?? 0;
        },
      },
      statusText: {
        configurable: true,
        get(this: object) {
          return xhrState.get(this)?.statusText ?? '';
        },
      },
      response: {
        configurable: true,
        get(this: object) {
          return xhrState.get(this)?.response ?? null;
        },
      },
    });

    const savedResponseClone = Response.prototype.clone;
    const savedResponseArrayBuffer = Response.prototype.arrayBuffer;

    vi.stubGlobal('XMLHttpRequest', HostWorkerXhr);
    vi.stubGlobal('fetch', async () => new Response(MINIMAL_WASM, { status: 200 }));

    try {
      const isolatedLoader = await import('../../src/wasm-loader');
      isolatedLoader.clearWasmModuleCache();

      // Simulate userland interceptors (MSW / Sinon / OpenTelemetry) mutating prototypes after module load.
      Reflect.set(HostWorkerXhr.prototype, 'open', () => {
        throw new Error('tampered XHR.prototype.open');
      });
      Reflect.set(HostWorkerXhr.prototype, 'send', () => {
        throw new Error('tampered XHR.prototype.send');
      });
      Object.defineProperty(HostWorkerXhr.prototype, 'status', {
        configurable: true,
        get: () => 500,
      });
      Object.defineProperty(HostWorkerXhr.prototype, 'response', {
        configurable: true,
        get: () => 'corrupted',
      });
      Response.prototype.clone = () => {
        throw new Error('tampered Response.prototype.clone');
      };
      Response.prototype.arrayBuffer = async () => {
        throw new Error('tampered Response.prototype.arrayBuffer');
      };
      vi.stubGlobal('WebAssembly', null);

      const syncBytes = isolatedLoader.fetchWasmBytesSync('https://example.test/intrinsic.wasm');
      expect(Array.from(syncBytes)).toEqual(Array.from(MINIMAL_WASM));

      const syncMod = isolatedLoader.loadWasmModuleSync(() => syncBytes, {
        cacheKey: 'intrinsic-sync',
      });
      expect(syncMod).toBeTruthy();

      const asyncMod = await isolatedLoader.loadWasmModule('https://example.test/intrinsic-a.wasm');
      expect(asyncMod).toBeTruthy();
    } finally {
      Response.prototype.clone = savedResponseClone;
      Response.prototype.arrayBuffer = savedResponseArrayBuffer;
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('preserves an intervening loadWasmModuleSync cache entry and isolates clearWasmModuleCache epochs', async () => {
    clearWasmModuleCache();

    // 1. Intervening loadWasmModuleSync while loadWasmModule is in-flight:
    let resolveAsync1!: (mod: WebAssembly.Module) => void;
    const gate1 = new Promise<WebAssembly.Module>((resolve) => {
      resolveAsync1 = resolve;
    });
    const asyncFlight = loadWasmModule(MINIMAL_WASM, {
      cacheKey: 'sync-race',
      webAssembly: {
        Module: WebAssembly.Module,
        compile: () => gate1,
      },
    });
    const syncWinner = loadWasmModuleSync(MINIMAL_WASM, { cacheKey: 'sync-race' });
    const distinctAsyncMod = new WebAssembly.Module(MINIMAL_WASM);
    expect(distinctAsyncMod).not.toBe(syncWinner);
    resolveAsync1(distinctAsyncMod);
    const asyncResolved = await asyncFlight;
    expect(asyncResolved).toBe(syncWinner);
    expect(loadWasmModuleSync(MINIMAL_WASM, { cacheKey: 'sync-race' })).toBe(syncWinner);

    // 2. clearWasmModuleCache while flightA is in-flight must neither repopulate
    // compiledModules nor delete a newer flightB from inflightCompilations:
    let resolveFlightA!: (mod: WebAssembly.Module) => void;
    let resolveFlightB!: (mod: WebAssembly.Module) => void;
    const gateA = new Promise<WebAssembly.Module>((resolve) => {
      resolveFlightA = resolve;
    });
    const gateB = new Promise<WebAssembly.Module>((resolve) => {
      resolveFlightB = resolve;
    });

    const flightA = loadWasmModule(MINIMAL_WASM, {
      cacheKey: 'epoch-key',
      webAssembly: { Module: WebAssembly.Module, compile: () => gateA },
    });
    clearWasmModuleCache('epoch-key');

    let compileBCalls = 0;
    const compileB = () => {
      compileBCalls += 1;
      return gateB;
    };
    const flightB1 = loadWasmModule(MINIMAL_WASM, {
      cacheKey: 'epoch-key',
      webAssembly: { Module: WebAssembly.Module, compile: compileB },
    });

    // Settle stale flightA while flightB1 is still pending:
    const modA = new WebAssembly.Module(MINIMAL_WASM);
    resolveFlightA(modA);
    await flightA;

    // Stale flightA must NOT have populated compiledModules, and must NOT have evicted flightB1!
    expect(hasCachedWasmModule('epoch-key')).toBe(false);
    const flightB2 = loadWasmModule(MINIMAL_WASM, {
      cacheKey: 'epoch-key',
      webAssembly: { Module: WebAssembly.Module, compile: compileB },
    });
    expect(compileBCalls).toBe(1);

    const modB = new WebAssembly.Module(MINIMAL_WASM);
    resolveFlightB(modB);
    expect(await flightB1).toBe(modB);
    expect(await flightB2).toBe(modB);
    expect(hasCachedWasmModule('epoch-key')).toBe(true);
  });

  it('reads C strings from WebAssembly.Memory with unsigned pointer coercion', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const bytes = new Uint8Array(mem.buffer);
    const offset = 128;
    bytes.set([0x4f, 0x4b, 0x00], offset);
    expect(readWasmCString(mem, offset, 'FALLBACK')).toBe('OK');
    expect(readWasmCString(mem, 0, 'FALLBACK')).toBe('FALLBACK');
    expect(readWasmCString(mem, offset + 2, 'FALLBACK')).toBe('FALLBACK');
  });

  it('fetches WASM bytes synchronously via XMLHttpRequest and integrates with loadWasmModuleSync', () => {
    clearWasmModuleCache();
    const calls: Array<{ method: string; url: string; async: boolean; responseType: string }> = [];

    class StubWorkerXhr {
      responseType: '' | 'arraybuffer' = '';
      status = 200;
      statusText = 'OK';
      response: unknown = null;
      private opened: { method: string; url: string; async: boolean } | null = null;

      open(method: string, url: string, async: boolean): void {
        this.opened = { method, url, async };
      }

      send(): void {
        if (!this.opened) throw new Error('send before open');
        calls.push({ ...this.opened, responseType: this.responseType });
        const copy = new Uint8Array(MINIMAL_WASM.byteLength);
        copy.set(MINIMAL_WASM);
        this.response = copy.buffer;
      }
    }

    const wasmUrl = new URL('https://example.test/assets/sidecar.wasm');
    const bytes = fetchWasmBytesSync(wasmUrl, { XMLHttpRequestImpl: StubWorkerXhr });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(bytes)).toEqual(Array.from(MINIMAL_WASM));
    expect(calls).toEqual([
      {
        method: 'GET',
        url: 'https://example.test/assets/sidecar.wasm',
        async: false,
        responseType: 'arraybuffer',
      },
    ]);

    const mod1 = loadWasmModuleSync(
      () => fetchWasmBytesSync(wasmUrl, { XMLHttpRequestImpl: StubWorkerXhr }),
      { cacheKey: 'sync-xhr-sidecar' },
    );
    const mod2 = loadWasmModuleSync(
      () => fetchWasmBytesSync(wasmUrl, { XMLHttpRequestImpl: StubWorkerXhr }),
      { cacheKey: 'sync-xhr-sidecar' },
    );
    expect(mod1).toBeInstanceOf(WebAssembly.Module);
    expect(mod2).toBe(mod1);
    expect(calls).toHaveLength(2);
  });

  it('throws coded EIO or ENOSYS RuntimeError from fetchWasmBytesSync on HTTP, network, or missing XHR failures', () => {
    clearWasmModuleCache();
    const captureThrown = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (err) {
        return err;
      }
      throw new Error('Expected function to throw');
    };

    expect(
      captureThrown(() =>
        fetchWasmBytesSync('https://example.test/missing-xhr.wasm', { XMLHttpRequestImpl: null }),
      ),
    ).toSatisfy(
      (err: unknown) =>
        err instanceof RuntimeError && err instanceof UnsupportedError && err.code === 'ENOSYS',
    );

    class WindowMainThreadXhr {
      status = 0;
      statusText = '';
      response: unknown = null;
      open(): void {}
      set responseType(_value: '' | 'arraybuffer') {
        const domErr = new Error('InvalidAccessError');
        domErr.name = 'InvalidAccessError';
        throw domErr;
      }
      get responseType(): '' | 'arraybuffer' {
        return '';
      }
      send(): void {}
    }

    expect(
      captureThrown(() =>
        fetchWasmBytesSync('https://example.test/window-sync.wasm', {
          XMLHttpRequestImpl: WindowMainThreadXhr,
        }),
      ),
    ).toSatisfy(
      (err: unknown) =>
        err instanceof RuntimeError && err instanceof UnsupportedError && err.code === 'ENOSYS',
    );

    class NotFoundXhr {
      responseType: '' | 'arraybuffer' = '';
      status = 404;
      statusText = 'Not Found';
      response: unknown = null;
      open(): void {}
      send(): void {}
    }

    expect(
      captureThrown(() =>
        loadWasmModuleSync(
          () =>
            fetchWasmBytesSync('https://example.test/404.wasm', {
              XMLHttpRequestImpl: NotFoundXhr,
            }),
          { cacheKey: 'xhr-404' },
        ),
      ),
    ).toSatisfy(
      (err: unknown) =>
        err instanceof RuntimeError &&
        err instanceof ChannelError &&
        err.code === 'EIO' &&
        err.message.includes('404'),
    );
    expect(hasCachedWasmModule('xhr-404')).toBe(false);

    class NetworkErrorXhr {
      responseType: '' | 'arraybuffer' = '';
      status = 0;
      statusText = '';
      response: unknown = null;
      open(): void {}
      send(): void {
        throw new Error('NetworkError: Failed to execute send on XMLHttpRequest');
      }
    }

    expect(
      captureThrown(() =>
        fetchWasmBytesSync('https://example.test/net-err.wasm', {
          XMLHttpRequestImpl: NetworkErrorXhr,
        }),
      ),
    ).toSatisfy(
      (err: unknown) =>
        err instanceof RuntimeError && err instanceof ChannelError && err.code === 'EIO',
    );

    class BadPayloadXhr {
      responseType: '' | 'arraybuffer' = '';
      status = 200;
      statusText = 'OK';
      response: unknown = 'not-an-arraybuffer';
      open(): void {}
      send(): void {}
    }

    expect(
      captureThrown(() =>
        fetchWasmBytesSync('https://example.test/bad-payload.wasm', {
          XMLHttpRequestImpl: BadPayloadXhr,
        }),
      ),
    ).toSatisfy(
      (err: unknown) =>
        err instanceof RuntimeError && err instanceof ChannelError && err.code === 'EIO',
    );
  });

  it('compiles zero Brotli or Zstd WASM modules during cold zlib creation until first codec call', () => {
    clearWasmModuleCache();
    withSidecarSyncXhrStub((requested) => {
      const zlib = createZlib((cb) => queueMicrotask(cb));
      const requireSyncCodec = (fn: unknown): ((data: string) => Uint8Array) => {
        if (typeof fn !== 'function') throw new Error('Expected sync compression function');
        return (data: string): Uint8Array => {
          const out: unknown = Reflect.apply(fn, undefined, [data]);
          if (!(out instanceof Uint8Array)) throw new Error('Expected Uint8Array output');
          return out;
        };
      };

      // Non-WASM zlib APIs and even cold stream construction pay zero WASM fetch/compilation cost.
      const deflateSync = requireSyncCodec(zlib.deflateSync);
      expect(deflateSync('cold-boot-check').byteLength).toBeGreaterThan(0);
      expect(hasCachedWasmModule(BROTLI_WASM_CACHE_KEY)).toBe(false);
      expect(hasCachedWasmModule(ZSTD_WASM_CACHE_KEY)).toBe(false);
      expect(requested).toEqual([]);

      const brotliCompressSync = requireSyncCodec(zlib.brotliCompressSync);
      expect(brotliCompressSync('first-brotli').byteLength).toBeGreaterThan(0);
      expect(hasCachedWasmModule(BROTLI_WASM_CACHE_KEY)).toBe(true);
      expect(hasCachedWasmModule(ZSTD_WASM_CACHE_KEY)).toBe(false);
      expect(requested).toEqual(['zlib-brotli.wasm']);

      const zstdCompressSync = requireSyncCodec(zlib.zstdCompressSync);
      expect(zstdCompressSync('first-zstd').byteLength).toBeGreaterThan(0);
      expect(hasCachedWasmModule(ZSTD_WASM_CACHE_KEY)).toBe(true);
      expect(requested).toEqual(['zlib-brotli.wasm', 'zlib-zstd.wasm']);
    });
  });

  it('compiles zero SQLite WASM modules during cold builtin creation until first DatabaseSync open', () => {
    clearWasmModuleCache();
    withSidecarSyncXhrStub((requested) => {
      const sqlite = createSqliteBuiltin({
        fs: {
          constants: {
            F_OK: 0,
            R_OK: 4,
            W_OK: 2,
            O_RDONLY: 0,
            O_RDWR: 2,
            O_CREAT: 64,
            O_EXCL: 128,
          },
          accessSync: () => {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          },
          openSync: () => -1,
          closeSync: () => {},
          readSync: () => 0,
          writeSync: () => 0,
          ftruncateSync: () => {},
          fstatSync: () => ({ size: 0 }),
          fsyncSync: () => {},
          unlinkSync: () => {},
          mkdirSync: () => undefined,
          rmdirSync: () => {},
        },
        cwd: () => '/',
      });

      // Cold Worker boot / builtin surface inspection must not fetch or compile sqlite WASM.
      expect(typeof sqlite.DatabaseSync).toBe('function');
      expect(typeof sqlite.StatementSync).toBe('function');
      expect(sqlite.constants.SQLITE_CHANGESET_ABORT).toBe(2);
      const deferredDb = new sqlite.DatabaseSync(':memory:', { open: false });
      expect(deferredDb.isOpen).toBe(false);
      expect(hasCachedWasmModule(SQLITE_WASM_CACHE_KEY)).toBe(false);
      expect(requested).toEqual([]);

      // First actual database open fetches, compiles, and caches the SQLite WASM module.
      deferredDb.open();
      expect(deferredDb.isOpen).toBe(true);
      expect(hasCachedWasmModule(SQLITE_WASM_CACHE_KEY)).toBe(true);
      expect(requested).toEqual(['sqlite.wasm']);
      deferredDb.exec('CREATE TABLE items (val INTEGER); INSERT INTO items VALUES (42);');
      expect(deferredDb.prepare('SELECT val FROM items').get()).toEqual({ val: 42 });
      deferredDb.close();
    });
  });
});
