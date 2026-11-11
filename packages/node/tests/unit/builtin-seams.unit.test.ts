import { EventEmitter } from 'events';
import { registerHooks } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { createConsoleBuiltin } from '../../src/builtins/console-module';
import { createDnsBuiltins } from '../../src/builtins/dns';
import { registerExtraLibBuiltins } from '../../src/builtins/extra-lib';
import { createHttp2Builtin } from '../../src/builtins/http2';
import * as moduleExtrasMod from '../../src/builtins/module-extras';
import { createNetBuiltin } from '../../src/builtins/net';
import { createConstantsBuiltin, createOsBuiltin } from '../../src/builtins/os';
import { registerTestRunnerBuiltins } from '../../src/builtins/test-runner';
import { createTimersBuiltins } from '../../src/builtins/timers';
import { createTlsBuiltin } from '../../src/builtins/tls';
import { createTtyBuiltin } from '../../src/builtins/tty';
import { parseExecArgv } from '../../src/exec-argv';
import { createFs } from '../../src/fs';
import { createLoader } from '../../src/loader';
import {
  CAPACITY,
  HEADER_BYTES,
  Syscalls,
  createSyscallResponder,
  fault,
  record,
} from '../../src/protocol';

const publishedEsmSources = new Map<string, string>();
let hooksInstalled = false;

function ensureLoaderSeamHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('https://loader-seam.test/')) {
        return { url: specifier, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith('https://loader-seam.test/')) {
        const source = publishedEsmSources.get(new URL(url).pathname);
        if (source === undefined) {
          throw new Error(`Missing published ESM module for ${url}`);
        }
        return { format: 'module', source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}

function createInMemoryFs(files: Record<string, string>) {
  const shared = new SharedArrayBuffer(HEADER_BYTES + CAPACITY);
  const now = new Date(0);
  const responder = createSyscallResponder(shared, (op, args) => {
    const target = String(args[0] ?? '');
    if (op === 'fs.statSync' || op === 'fs.lstatSync') {
      if (target === '/') {
        return { mode: 0o040755, size: 0, atime: now, mtime: now, ctime: now, birthtime: now };
      }
      if (Object.hasOwn(files, target)) {
        return {
          mode: 0o100644,
          size: files[target]!.length,
          atime: now,
          mtime: now,
          ctime: now,
          birthtime: now,
        };
      }
      throw fault('ENOENT', `ENOENT: ${target}`);
    }
    if (op === 'fs.existsSync') {
      return target === '/' || Object.hasOwn(files, target);
    }
    if (op === 'fs.realpathSync') {
      if (target === '/' || Object.hasOwn(files, target)) return target;
      throw fault('ENOENT', `ENOENT: ${target}`);
    }
    if (op === 'fs.readFileSync') {
      if (!Object.hasOwn(files, target)) throw fault('ENOENT', `ENOENT: ${target}`);
      return files[target];
    }
    throw fault('ENOSYS', `Unhandled test syscall ${op}`);
  });
  // Invariant: Syscalls only invokes MessagePort.postMessage(data); synchronous
  // in-thread dispatch lets unit tests exercise Atomics control headers deterministically.
  const port = {
    postMessage: (data: unknown) => responder.handleMessage(data),
  } as unknown as MessagePort;
  const sys = new Syscalls(port, shared, 500, CAPACITY);
  const fs = createFs(sys, () => '/');
  fs.readFileSync = (filename: unknown) => {
    const key = String(filename);
    if (!Object.hasOwn(files, key)) throw fault('ENOENT', `ENOENT: ${key}`);
    return files[key];
  };
  return { sys, fs };
}

describe('Wave R1 modular builtin registry seams', () => {
  it('exposes R1a constants, network, TLS, HTTP/2, and DNS builtin factories with full deps', async () => {
    const { sys } = createInMemoryFs({});
    const stubProcess = Object.assign(new EventEmitter(), {
      platform: 'browser',
      arch: 'browser',
      env: {},
    });
    const osBuiltin = createOsBuiltin({
      process: stubProcess,
      advisoryFreeMemory: () => 1024,
    });
    const fsConstants: Record<string, unknown> = { O_RDONLY: 0, O_WRONLY: 1, F_OK: 0 };
    const cryptoConstants: Record<string, unknown> = { RSA_PKCS1_PADDING: 1 };
    const legacyConstants = createConstantsBuiltin({
      osConstants: osBuiltin.constants,
      fsConstants,
      cryptoConstants,
    });
    expect(legacyConstants).not.toBe(fsConstants);
    expect(Object.isFrozen(legacyConstants)).toBe(true);
    expect(legacyConstants).toMatchObject({
      ...fsConstants,
      ...cryptoConstants,
      ENOENT: 2,
      ENOSYS: 38,
      SIGHUP: 1,
      RTLD_LAZY: 1,
      PRIORITY_NORMAL: 0,
    });

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
    expect(net.isIP('127.0.0.1')).toBe(4);
    expect(net.isIP('999.0.0.1')).toBe(0);
    expect(net.isIP('::1')).toBe(6);
    expect(net.isIP('localhost')).toBe(0);
    expect(() => net.connect()).toThrowError(expect.objectContaining({ code: 'ENOSYS' }));

    const tls = createTlsBuiltin({ net });
    expect(() => tls.connect()).toThrowError(expect.objectContaining({ code: 'ENOSYS' }));

    const http2 = createHttp2Builtin();
    expect(http2.constants).toMatchObject({
      HTTP2_HEADER_LOCATION: 'location',
      HTTP2_HEADER_CONTENT_TYPE: 'content-type',
      HTTP2_HEADER_USER_AGENT: 'user-agent',
      HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
      HTTP_STATUS_TOO_MANY_REQUESTS: 429,
      HTTP_STATUS_REQUEST_TIMEOUT: 408,
      NGHTTP2_NO_ERROR: 0,
      DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096,
    });
    expect(http2.sensitiveHeaders).toBe(Symbol.for('nodejs.http2.sensitiveHeaders'));
    expect(() => new http2.Http2ServerRequest()).toThrowError(
      expect.objectContaining({ code: 'ENOSYS' }),
    );
    expect(() => new http2.Http2ServerResponse()).toThrowError(
      expect.objectContaining({ code: 'ENOSYS' }),
    );
    expect(() => http2.createServer()).toThrowError(expect.objectContaining({ code: 'ENOSYS' }));
    expect(() => http2.createSecureServer()).toThrowError(
      expect.objectContaining({ code: 'ENOSYS' }),
    );
    expect(() => http2.connect()).toThrowError(expect.objectContaining({ code: 'ENOSYS' }));

    const dnsBuiltins = createDnsBuiltins(net.isIP);
    expect(dnsBuiltins['dns/promises']).toBe(dnsBuiltins.dns.promises);
    await expect(dnsBuiltins['dns/promises'].lookup('localhost')).resolves.toEqual({
      address: '127.0.0.1',
      family: 4,
    });
    await expect(dnsBuiltins['dns/promises'].lookup('localhost', 6)).resolves.toEqual({
      address: '::1',
      family: 6,
    });
  });

  it('exposes R1b tty, timers, console, and lazy post-loader registerExtraLibBuiltins without eager getter evaluation', async () => {
    const stubStream = {
      write: () => true,
      isTTY: false,
      columns: undefined,
      rows: undefined,
    };
    const stubProcess = Object.assign(new EventEmitter(), {
      stdin: { isTTY: false },
      stdout: stubStream,
      stderr: stubStream,
      env: {},
      argv: ['/bin/node'],
      execArgv: [],
      version: 'v22.18.0',
      versions: { node: '22.18.0' },
      cwd: () => '/',
    });

    const tty = createTtyBuiltin({
      process: stubProcess,
      getTerminal: () => undefined,
    });
    expect(tty.isatty()).toBe(false);
    expect(() => new tty.ReadStream()).toThrowError(expect.objectContaining({ code: 'ENOSYS' }));

    const kPromisify = Symbol('kCustomPromisified');
    const makeHandle = (raw: ReturnType<typeof setTimeout>) => ({
      ref() {
        return this;
      },
      unref() {
        return this;
      },
      hasRef: () => true,
      refresh() {
        return this;
      },
      close() {
        clearTimeout(raw);
        return this;
      },
      cancel: () => clearTimeout(raw),
    });
    const guestSetTimeout = (fn: (...args: unknown[]) => void, delay = 1, ...args: unknown[]) =>
      makeHandle(setTimeout(() => fn(...args), delay));
    const guestClearTimeout = (handle: unknown) => {
      if (typeof handle === 'object' && handle !== null && 'cancel' in handle) {
        const cancel = Reflect.get(handle, 'cancel');
        if (typeof cancel === 'function') Reflect.apply(cancel, handle, []);
      }
    };
    const guestTimers = {
      setTimeout: guestSetTimeout,
      clearTimeout: guestClearTimeout,
      setImmediate: (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
        guestSetTimeout(fn, 0, ...args),
      clearImmediate: guestClearTimeout,
      setInterval: (fn: (...args: unknown[]) => void, _delay?: unknown, ...args: unknown[]) =>
        guestSetTimeout(fn, 1, ...args),
      clearInterval: guestClearTimeout,
    };

    const timersBuiltins = createTimersBuiltins({
      guestTimers,
      guestSetTimeout,
      guestClearTimeout,
      kCustomPromisifiedSymbol: kPromisify,
    });
    expect(timersBuiltins.timers).toBe(guestTimers);
    expect(Reflect.get(guestSetTimeout, kPromisify)).toBe(
      timersBuiltins['timers/promises'].setTimeout,
    );
    await expect(timersBuiltins['timers/promises'].setTimeout(1, 'ok')).resolves.toBe('ok');

    const guestConsole = {
      log: () => {},
      warn: () => {},
      error: () => {},
    };
    const consoleBuiltin = createConsoleBuiltin({ guestConsole, process: stubProcess });
    expect(consoleBuiltin).toBe(guestConsole);

    let lazyGetterTouches = 0;
    const target: Record<string, unknown> = {};
    Object.defineProperty(target, 'sqlite', {
      enumerable: true,
      configurable: true,
      get() {
        lazyGetterTouches += 1;
        return { DatabaseSync: class {} };
      },
    });
    registerExtraLibBuiltins(target, {
      process: stubProcess,
      fs: {},
      cwd: () => '/',
      setTimeout: guestSetTimeout,
      clearTimeout: guestClearTimeout,
      setImmediate: guestTimers.setImmediate,
      retain: () => {},
      release: () => {},
      util: {},
      events: EventEmitter,
      readline: {},
      stream: {},
      tty,
      console: consoleBuiltin,
      asyncHooks: {},
      vm: { runInNewContext: () => undefined },
      module: { createRequire: () => undefined },
    });
    expect(lazyGetterTouches).toBe(0);
    expect(Object.keys(target)).toEqual(['sqlite', 'sys', 'punycode', 'domain', 'repl']);
    for (const key of ['sys', 'punycode', 'domain', 'repl']) {
      const desc = Object.getOwnPropertyDescriptor(target, key);
      expect(typeof desc?.get).toBe('function');
      expect(desc?.enumerable).toBe(true);
      expect(desc?.configurable).toBe(true);
    }
  });

  it('wires loader.import and syncBuiltinESMExports into createModuleExtras to refresh live ESM builtin bindings', async () => {
    ensureLoaderSeamHooks();
    const { fs } = createInMemoryFs({
      '/probe.mjs': [
        "import fsDefault, { readSample } from 'node:fs';",
        'export function readNamed() { return readSample(); }',
        'export function readDefault() { return fsDefault.readSample(); }',
      ].join('\n'),
    });

    const mutableFsBuiltin: { readSample: () => string; label: string } = {
      readSample: () => 'initial-value',
      label: 'fs-v1',
    };
    const loaderBuiltins: Record<string, unknown> = {
      fs: mutableFsBuiltin,
    };
    const stubProcess = new EventEmitter();

    let capturedExtrasDeps: moduleExtrasMod.ModuleExtrasDeps | undefined;
    const spy = vi.spyOn(moduleExtrasMod, 'createModuleExtras').mockImplementation((deps) => {
      capturedExtrasDeps = deps;
      return {};
    });

    try {
      const scopeId = Math.random().toString(36).slice(2);
      const loader = createLoader(
        fs,
        loaderBuiltins,
        { process: stubProcess },
        {
          base: `https://loader-seam.test/__${scopeId}__/`,
          cwd: () => '/',
          retain: () => () => {},
          publish: async (entries) => {
            for (const [pathname, source] of entries) {
              publishedEsmSources.set(pathname, source);
            }
          },
        },
        parseExecArgv([]),
      );

      expect(typeof loader.import).toBe('function');
      expect(capturedExtrasDeps).toBeDefined();
      expect(capturedExtrasDeps?.builtins).toBe(loaderBuiltins);
      expect(capturedExtrasDeps?.process).toBe(stubProcess);
      expect(typeof capturedExtrasDeps?.syncBuiltinESMExports).toBe('function');

      const ns = await loader.import('/entry.mjs', '/probe.mjs');
      if (
        !record(ns) ||
        typeof ns.readNamed !== 'function' ||
        typeof ns.readDefault !== 'function'
      ) {
        throw new Error('Expected /probe.mjs namespace exports');
      }

      expect(ns.readNamed()).toBe('initial-value');
      expect(ns.readDefault()).toBe('initial-value');

      // Mutate CJS builtin property: default export sees it immediately, named ESM
      // binding stays on old snapshot until syncBuiltinESMExports() refreshes it.
      mutableFsBuiltin.readSample = () => 'synced-value';
      expect(ns.readDefault()).toBe('synced-value');
      expect(ns.readNamed()).toBe('initial-value');

      capturedExtrasDeps?.syncBuiltinESMExports();
      expect(ns.readNamed()).toBe('synced-value');
    } finally {
      spy.mockRestore();
    }
  });

  it('registers lazy enumerable/configurable test and test/reporters builtins on R1c seam without eager evaluation', () => {
    let loadModuleCalls = 0;
    const target: Record<string, unknown> = { fs: {} };
    registerTestRunnerBuiltins(target, {
      process: new EventEmitter(),
      fs: {},
      cwd: () => '/',
      setTimeout: () => ({}),
      clearTimeout: () => {},
      setInterval: () => ({}),
      clearInterval: () => {},
      setImmediate: () => ({}),
      clearImmediate: () => {},
      hrtimeNs: () => 0n,
      retain: () => {},
      release: () => {},
      loadModule: () => {
        loadModuleCalls += 1;
        return {};
      },
      importModule: async () => ({}),
      events: EventEmitter,
      stream: {},
      util: {},
      asyncHooks: {},
    });
    expect(Object.keys(target)).toEqual(['fs', 'test', 'test/reporters']);
    expect(loadModuleCalls).toBe(0);
    expect(typeof Object.getOwnPropertyDescriptor(target, 'test')?.get).toBe('function');
    expect(typeof Object.getOwnPropertyDescriptor(target, 'test/reporters')?.get).toBe('function');
  });
});
