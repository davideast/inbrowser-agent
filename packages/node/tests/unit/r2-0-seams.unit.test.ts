import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { createBufferBuiltin } from '../../src/builtins/buffer';
import { type CryptoBuiltinDeps, createCryptoBuiltin } from '../../src/builtins/crypto';
import { type FsBuiltinsDeps, createFsBuiltins } from '../../src/builtins/fs';
import { type HttpBuiltinsDeps, createHttpBuiltins } from '../../src/builtins/http';
import { createNetBuiltin } from '../../src/builtins/net';
import { createPerfHooksBuiltin } from '../../src/builtins/perf-hooks';
import { createTlsBuiltin } from '../../src/builtins/tls';
import { createV8Builtin } from '../../src/builtins/v8';
import { createWorkerThreadsBuiltin } from '../../src/builtins/worker-threads';
import { createFs } from '../../src/fs';
import {
  CAPACITY,
  HEADER_BYTES,
  Syscalls,
  createSyscallResponder,
  fault,
} from '../../src/protocol';
import { createThreadPort } from '../../src/thread-port';
import { record } from '../../src/value-guards';

describe('Wave R2.0 modular builtin registry seams', () => {
  it('Slice 1: createBufferBuiltin preserves Buffer, encoding checks, and size constants', () => {
    const stubProcess = new EventEmitter();
    const bufferBuiltin = createBufferBuiltin({
      process: stubProcess,
      retain: () => () => {},
    });

    expect(Object.keys(bufferBuiltin)).toEqual([
      'Buffer',
      'SlowBuffer',
      'transcode',
      'isUtf8',
      'isAscii',
      'kMaxLength',
      'kStringMaxLength',
      'btoa',
      'atob',
      'constants',
      'INSPECT_MAX_BYTES',
      'Blob',
      'resolveObjectURL',
      'File',
    ]);
    expect(bufferBuiltin.Buffer.from('68656c6c6f', 'hex').toString('utf8')).toBe('hello');
    expect(bufferBuiltin.isUtf8(bufferBuiltin.Buffer.from('héllo', 'utf8'))).toBe(true);
    expect(bufferBuiltin.isUtf8(Uint8Array.of(0xff, 0xfe))).toBe(false);
    expect(bufferBuiltin.isAscii(bufferBuiltin.Buffer.from('ascii-only'))).toBe(true);
    expect(bufferBuiltin.isAscii(Uint8Array.of(0x7f, 0x80))).toBe(false);
    expect(bufferBuiltin.kMaxLength).toBe(9007199254740991);
    expect(bufferBuiltin.kStringMaxLength).toBe(536870888);
    expect(bufferBuiltin.constants).toEqual({
      MAX_LENGTH: 9007199254740991,
      MAX_STRING_LENGTH: 536870888,
    });
    expect(createBufferBuiltin().Buffer).toBe(bufferBuiltin.Buffer);
  });

  it('Slice 2: createV8Builtin preserves startupSnapshot and advisory getHeapStatistics behavior', () => {
    for (const invalidLimit of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '4096']) {
      const v8Invalid = createV8Builtin({
        advisoryHeapLimit: invalidLimit,
        callTimeoutMs: 500,
      });
      expect(v8Invalid.startupSnapshot.isBuildingSnapshot()).toBe(0);
      expect(() => v8Invalid.getHeapStatistics()).toThrowError(
        expect.objectContaining({
          code: 'ENOSYS',
          message: 'Browser page advisory heap limit is unavailable',
        }),
      );
    }

    const seenTimeouts: number[] = [];
    const v8Sampled = createV8Builtin({
      advisoryHeapLimit: 1048576,
      callTimeoutMs: 750,
      samplePageHeap: (timeoutMs) => {
        seenTimeouts.push(timeoutMs);
        return { total: 524288, used: 262144 };
      },
      process: new EventEmitter(),
      stream: {},
      fs: {},
      cwd: () => '/',
    });
    expect(v8Sampled.startupSnapshot.isBuildingSnapshot()).toBe(0);
    expect(v8Sampled.getHeapStatistics()).toEqual({
      total_heap_size: 524288,
      used_heap_size: 262144,
      heap_size_limit: 1048576,
    });
    expect(seenTimeouts).toEqual([750]);

    const v8Unsampled = createV8Builtin({
      advisoryHeapLimit: 1048576,
      callTimeoutMs: 750,
      samplePageHeap: () => undefined,
    });
    expect(v8Unsampled.getHeapStatistics()).toEqual({
      heap_size_limit: 1048576,
    });
  });

  it('Slice 3: createPerfHooksBuiltin delegates to createPerfHooks with setImmediate and hrtimeNs seam', () => {
    const queued: Array<() => void> = [];
    const perfHooks = createPerfHooksBuiltin({
      setImmediate: (callback) => {
        queued.push(callback);
        return {};
      },
      hrtimeNs: () => 1_000_000n,
      setTimeout: () => ({}),
      clearTimeout: () => {},
      setInterval: () => ({}),
      clearInterval: () => {},
      process: new EventEmitter(),
    });

    expect(perfHooks.performance).toBe(globalThis.performance);
    expect(perfHooks.Performance).toBe(globalThis.Performance);
    expect(perfHooks.PerformanceEntry).toBe(globalThis.PerformanceEntry);
    expect(perfHooks.PerformanceMark).toBe(globalThis.PerformanceMark);
    expect(perfHooks.PerformanceMeasure).toBe(globalThis.PerformanceMeasure);

    const constantsDesc = Object.getOwnPropertyDescriptor(perfHooks, 'constants');
    expect(constantsDesc).toMatchObject({
      writable: false,
      enumerable: true,
      configurable: false,
    });
    const perfConstants: unknown = Reflect.get(perfHooks, 'constants');
    expect(record(perfConstants) ? perfConstants.NODE_PERFORMANCE_GC_MAJOR : undefined).toBe(4);

    const histogram = perfHooks.createHistogram();
    histogram.record(100);
    histogram.record(200);
    expect(histogram.count).toBe(2);

    const observedNames: string[] = [];
    const observer = new perfHooks.PerformanceObserver(
      (list: { getEntries(): PerformanceEntry[] }) => {
        for (const entry of list.getEntries()) {
          observedNames.push(entry.name);
        }
      },
    );
    try {
      observer.observe({ entryTypes: ['mark'] });
      perfHooks.performance.mark('r2-0-seam-mark');
      expect(observedNames).toEqual([]);
      expect(queued.length).toBe(1);
      queued.shift()?.();
      expect(observedNames).toEqual(['r2-0-seam-mark']);
    } finally {
      observer.disconnect();
      perfHooks.performance.clearMarks('r2-0-seam-mark');
    }
  });

  it('Slice 4: createWorkerThreadsBuiltin preserves main-thread and worker-thread module & ready() behavior', async () => {
    const main = createWorkerThreadsBuiltin({
      defaults: () => ({ cwd: '/', env: {}, pid: 1, execArgv: [] }),
      retain: () => {},
      release: () => {},
      output: () => {},
      process: new EventEmitter(),
      events: EventEmitter,
      stream: {},
      fs: {},
      setTimeout: () => ({}),
      clearTimeout: () => {},
      setImmediate: () => ({}),
    });

    expect(main.module.isMainThread).toBe(true);
    expect(main.module.parentPort).toBeNull();
    expect(main.module.workerData).toBeNull();
    expect(main.module.threadId).toBe(0);
    expect(() => new main.module.MessageChannel()).toThrowError(
      expect.objectContaining({ code: 'ENOSYS' }),
    );
    expect(() => new main.module.Worker('')).toThrowError(
      expect.objectContaining({ code: 'EINVAL' }),
    );
    expect(() => new main.module.Worker('/entry.js', { eval: true })).toThrowError(
      expect.objectContaining({ code: 'ENOSYS' }),
    );
    main.ready();

    const channel = new MessageChannel();
    const parentPeer = createThreadPort(
      channel.port1,
      () => {},
      () => {},
      true,
    );
    try {
      const child = createWorkerThreadsBuiltin({
        defaults: () => ({ cwd: '/app', env: { MODE: 'test' }, pid: 1, execArgv: [] }),
        retain: () => {},
        release: () => {},
        output: () => {},
        context: { port: channel.port2, data: { tag: 'worker-1' }, id: 7 },
      });

      expect(child.module.isMainThread).toBe(false);
      expect(child.module.threadId).toBe(7);
      expect(child.module.workerData).toEqual({ tag: 'worker-1' });
      expect(child.module.parentPort).not.toBeNull();

      const received = new Promise<unknown>((resolve) => {
        child.module.parentPort?.once('message', (msg: unknown) => resolve(msg));
      });
      parentPeer.api.postMessage({ count: 3 });
      child.ready();
      await expect(received).resolves.toEqual({ count: 3 });
    } finally {
      parentPeer.stop();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it('Slice 5: createHttpBuiltins, createFsBuiltins, and createCryptoBuiltin accept enriched runtime deps', async () => {
    const channel = new MessageChannel();
    const shared = new SharedArrayBuffer(HEADER_BYTES + CAPACITY);
    const files: Record<string, string> = { '/greeting.txt': 'hello seam' };
    const responder = createSyscallResponder(shared, (op, args) => {
      if (op === 'fs.constants') {
        return { O_RDONLY: 0, O_WRONLY: 1, F_OK: 0 };
      }
      if (op === 'fs.readFileSync') {
        const key = String(args[0] ?? '');
        if (!Object.hasOwn(files, key)) throw fault('ENOENT', `ENOENT: ${key}`);
        return files[key];
      }
      throw fault('ENOSYS', `Unhandled test syscall ${op}`);
    });
    channel.port1.postMessage = (data: unknown) => {
      responder.handleMessage(data);
    };

    try {
      const sys = new Syscalls(channel.port1, shared, 500, CAPACITY);
      const stubProcess = new EventEmitter();
      const fs = createFs(sys, () => '/');
      fs.readFileSync = (filename: unknown) => {
        const key = String(filename);
        if (!Object.hasOwn(files, key)) throw fault('ENOENT', `ENOENT: ${key}`);
        return files[key];
      };

      const net = createNetBuiltin({
        sys,
        process: stubProcess,
        retain: () => {},
        release: () => {},
        events: EventEmitter,
        stream: {},
        setTimeout: () => ({}),
        clearTimeout: () => {},
        setImmediate: () => ({}),
      });
      const tls = createTlsBuiltin({ net });

      const httpDeps: HttpBuiltinsDeps = {
        sys,
        retain: () => {},
        release: () => {},
        httpAgentMode: 'socket',
        httpOmitHeaders: undefined,
        responseBytes: 1048576,
        process: stubProcess,
        events: EventEmitter,
        stream: {},
        net,
        tls,
        setTimeout: () => ({}),
        clearTimeout: () => {},
        setImmediate: () => ({}),
        clearImmediate: () => {},
        setInterval: () => ({}),
        clearInterval: () => {},
      };
      const { http, https } = createHttpBuiltins(httpDeps);
      expect(http.module.STATUS_CODES['200']).toBe('OK');
      expect(http.module.METHODS).toContain('GET');
      expect(typeof http.dispatch).toBe('function');
      expect(typeof http.upgrade).toBe('function');
      expect(() => https.createServer()).toThrowError(expect.objectContaining({ code: 'ENOSYS' }));

      let workedCalls = 0;
      const fsDeps: FsBuiltinsDeps = {
        fs,
        sys,
        port: channel.port1,
        cwd: () => '/',
        retain: () => {},
        release: () => {},
        worked: () => {
          workedCalls += 1;
        },
        process: stubProcess,
        events: EventEmitter,
        stream: {},
        setTimeout: () => ({}),
        clearTimeout: () => {},
        setInterval: () => ({}),
        clearInterval: () => {},
        setImmediate: () => ({}),
      };
      const fsBuiltins = createFsBuiltins(fsDeps);
      expect(fsBuiltins.constants).toEqual({ ...fsBuiltins.fs.constants });
      expect(fsBuiltins.constants).toMatchObject({
        O_RDONLY: 0,
        O_WRONLY: 1,
        F_OK: 0,
        O_DSYNC: 4096,
        UV_FS_O_FILEMAP: 0,
        UV_DIRENT_FILE: 1,
      });
      expect(fsBuiltins.constants).not.toBe(fsBuiltins.fs.constants);
      expect(fsBuiltins['fs/promises']).toBe(fsBuiltins.fs.promises);
      const readFilePromise = Reflect.get(fsBuiltins['fs/promises'], 'readFile');
      expect(typeof readFilePromise).toBe('function');
      if (typeof readFilePromise === 'function') {
        await expect(
          Reflect.apply(readFilePromise, fsBuiltins['fs/promises'], ['/greeting.txt']),
        ).resolves.toBe('hello seam');
      }
      expect(workedCalls).toBe(1);

      const cryptoDeps: CryptoBuiltinDeps = {
        retain: () => () => {},
        setImmediate: (cb) => {
          queueMicrotask(cb);
          return {};
        },
        schedule: (cb) => queueMicrotask(cb),
        process: stubProcess,
        stream: {},
      };
      const cryptoBuiltin = createCryptoBuiltin(cryptoDeps);
      expect(cryptoBuiltin.randomUUID()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(() => cryptoBuiltin.randomUUID({})).toThrowError(
        expect.objectContaining({ code: 'ENOSYS' }),
      );
      expect(cryptoBuiltin.getHashes()).toContain('sha256');
    } finally {
      responder.dispose();
      channel.port1.close();
      channel.port2.close();
    }
  });
});
