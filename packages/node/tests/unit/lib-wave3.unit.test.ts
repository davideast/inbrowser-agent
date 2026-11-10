import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';
import { createConsoleBuiltin } from '../../src/builtins/console-module';
import { registerExtraLibBuiltins } from '../../src/builtins/extra-lib';
import { createModuleExtras } from '../../src/builtins/module-extras';
import { createTimersBuiltins } from '../../src/builtins/timers';
import { createTtyBuiltin } from '../../src/builtins/tty';
import { Console } from '../../src/console';

function createSink(isTTY = false) {
  let text = '';
  const stream = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        text += String(chunk);
        callback();
      },
    }),
    { isTTY },
  );
  return {
    stream,
    read: () => text,
    reset: () => {
      text = '';
    },
  };
}

describe('Lane R1b Slice 1 — console.Console & node:console parity', () => {
  it('constructs Console with positional or options args, supports call without new, and validates options with Node error codes', () => {
    const out = createSink();
    const err = createSink();

    // Call without `new`
    const withoutNew = Reflect.apply(Console, undefined, [out.stream, err.stream]);
    expect(withoutNew).toBeInstanceOf(Console);
    expect(Object.prototype.toString.call(withoutNew)).toBe('[object console]');

    expect(() => new Console(undefined)).toThrowError(
      expect.objectContaining({ name: 'TypeError', code: 'ERR_CONSOLE_WRITABLE_STREAM' }),
    );
    expect(() => new Console({ stdout: out.stream, stderr: {} })).toThrowError(
      expect.objectContaining({ name: 'TypeError', code: 'ERR_CONSOLE_WRITABLE_STREAM' }),
    );
    expect(() =>
      Reflect.construct(Console, [{ stdout: out.stream, colorMode: 'invalid' }]),
    ).toThrowError(expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE' }));
    expect(() =>
      Reflect.construct(Console, [{ stdout: out.stream, inspectOptions: [] }]),
    ).toThrowError(expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }));
    expect(
      () =>
        new Console({
          stdout: out.stream,
          colorMode: false,
          inspectOptions: { colors: true },
        }),
    ).toThrowError(
      expect.objectContaining({ name: 'TypeError', code: 'ERR_INCOMPATIBLE_OPTION_PAIR' }),
    );
  });

  it('maintains independent per-instance counts, timers, groups, table, trace, clear, and upgrades global console in-place', () => {
    const outA = createSink();
    const errA = createSink();
    const outB = createSink(true);
    const warnings: Array<{ name: string; message: string }> = [];
    const stubProcess = Object.assign(new EventEmitter(), {
      stdout: outB.stream,
      stderr: errA.stream,
      env: { TERM: 'xterm-256color' },
      hrtime: process.hrtime,
      emitWarning: (warning: unknown, type?: unknown) => {
        warnings.push({
          name: typeof type === 'string' ? type : 'Warning',
          message: String(warning),
        });
      },
    });

    const a = new Console({ stdout: outA.stream, stderr: errA.stream, colorMode: false });
    const b = new Console({ stdout: outB.stream, stderr: errA.stream, colorMode: false });

    // Independent counters
    const { count, countReset } = a;
    count();
    count('default');
    b.count('default');
    count('item');
    countReset('item');
    count('item');
    expect(outA.read()).toBe('default: 1\ndefault: 2\nitem: 1\nitem: 1\n');
    expect(outB.read()).toBe('default: 1\n');

    outA.reset();
    outB.reset();

    // Timers + trace + dirxml + table
    a.time('op');
    a.timeLog('op', 'mid', 7);
    a.timeEnd('op');
    expect(outA.read()).toMatch(/^op: [\d.]+(ms|s) mid 7\nop: [\d.]+(ms|s)\n$/);

    outA.reset();
    a.dirxml('xml', 123);
    expect(outA.read()).toBe('xml 123\n');

    outA.reset();
    a.table([
      { name: 'alpha', score: 10 },
      { name: 'beta', score: 20 },
    ]);
    expect(outA.read()).toContain('│ (index) │ name');
    expect(outA.read()).toContain("│ 0       │ 'alpha' │ 10    │");

    a.trace('boom', 99);
    expect(errA.read()).toContain('Trace: boom 99\n');

    // Global console upgrade in-place via createConsoleBuiltin
    const guestConsole: Record<string, unknown> = {
      log: () => {},
      warn: () => {},
      error: () => {},
    };
    const upgraded = createConsoleBuiltin({ guestConsole, process: stubProcess });
    expect(upgraded).toBe(guestConsole);
    expect(upgraded.Console).toBe(Console);
    expect(upgraded instanceof Console).toBe(true);
    expect(Object.prototype.toString.call(upgraded)).toBe('[object console]');
    expect(typeof upgraded.profile).toBe('function');
    expect(typeof upgraded.profileEnd).toBe('function');
    expect(typeof upgraded.timeStamp).toBe('function');

    // clear() on TTY stdout emits cursorTo(0,0) + clearScreenDown()
    outB.reset();
    if (
      typeof upgraded.clear !== 'function' ||
      typeof upgraded.countReset !== 'function' ||
      typeof upgraded.timeEnd !== 'function'
    ) {
      throw new Error('Expected upgraded console methods');
    }
    upgraded.clear();
    expect(outB.read()).toBe('\u001b[1;1H\u001b[0J');

    // Missing counter / timer warnings route through process.emitWarning
    upgraded.countReset('absent');
    upgraded.timeEnd('absent-timer');
    expect(warnings).toEqual([
      { name: 'Warning', message: "Count for 'absent' does not exist" },
      { name: 'Warning', message: "No such label 'absent-timer' for console.timeEnd()" },
    ]);

    // PassThrough stream works as Console target too
    const pt = new PassThrough();
    const cPt = new Console(pt);
    cPt.log('hello %s', 'stream');
    expect(String(pt.read())).toBe('hello stream\n');
  });
});

describe('Lane R1b Slice 2 — timers/promises & timers custom promisify parity', () => {
  it('supports setImmediate, setInterval async iterable with clean break/abort, scheduler.wait/yield, and kCustomPromisifiedSymbol on setImmediate', async () => {
    let activeIntervals = 0;
    const makeHandle = (clear: () => void) => ({
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
        clear();
        return this;
      },
      cancel: clear,
    });
    const guestSetTimeout = (fn: (...args: unknown[]) => void, delay = 1, ...args: unknown[]) => {
      const raw = setTimeout(() => fn(...args), delay);
      return makeHandle(() => clearTimeout(raw));
    };
    const guestClearTimeout = (handle: unknown) => {
      if (typeof handle === 'object' && handle !== null && 'cancel' in handle) {
        const cancel = Reflect.get(handle, 'cancel');
        if (typeof cancel === 'function') Reflect.apply(cancel, handle, []);
      }
    };
    const guestTimers = {
      setTimeout: guestSetTimeout,
      clearTimeout: guestClearTimeout,
      setImmediate: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
        const raw = setImmediate(() => fn(...args));
        return makeHandle(() => clearImmediate(raw));
      },
      clearImmediate: guestClearTimeout,
      setInterval: (fn: (...args: unknown[]) => void, delay: unknown = 1, ...args: unknown[]) => {
        activeIntervals += 1;
        let cleared = false;
        const raw = setInterval(() => fn(...args), typeof delay === 'number' ? delay : 1);
        return makeHandle(() => {
          if (!cleared) {
            cleared = true;
            activeIntervals -= 1;
            clearInterval(raw);
          }
        });
      },
      clearInterval: guestClearTimeout,
    };

    const built = createTimersBuiltins({
      guestTimers,
      guestSetTimeout,
      guestClearTimeout,
      kCustomPromisifiedSymbol: promisify.custom,
    });
    const tp = built['timers/promises'];

    expect(Reflect.get(guestTimers.setImmediate, promisify.custom)).toBe(tp.setImmediate);
    await expect(
      Reflect.apply(promisify(guestTimers.setImmediate), undefined, ['imm-val']),
    ).resolves.toBe('imm-val');

    await expect(tp.setImmediate('direct', { ref: false })).resolves.toBe('direct');
    await expect(
      Reflect.apply(tp.setImmediate, undefined, ['x', 'bad-opts']),
    ).rejects.toMatchObject({
      code: 'ERR_INVALID_ARG_TYPE',
    });

    const preAborted = new AbortController();
    preAborted.abort('stop-imm');
    await expect(tp.setImmediate('x', { signal: preAborted.signal })).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORT_ERR',
      cause: 'stop-imm',
    });

    // setInterval break cancels underlying interval handle cleanly
    const seen: string[] = [];
    for await (const tick of tp.setInterval(2, 'pulse')) {
      seen.push(String(tick));
      if (seen.length === 3) break;
    }
    expect(seen).toEqual(['pulse', 'pulse', 'pulse']);
    expect(activeIntervals).toBe(0);

    // setInterval abort during iteration
    const iterAbort = new AbortController();
    let count = 0;
    await expect(
      (async () => {
        for await (const item of tp.setInterval(2, 'tick', { signal: iterAbort.signal })) {
          expect(item).toBe('tick');
          count += 1;
          if (count === 2) iterAbort.abort('halt');
        }
      })(),
    ).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR', cause: 'halt' });
    expect(activeIntervals).toBe(0);

    // scheduler.yield & scheduler.wait + ERR_INVALID_THIS brand check
    await expect(tp.scheduler.yield()).resolves.toBeUndefined();
    await expect(tp.scheduler.wait(2)).resolves.toBeUndefined();
    expect(() => Reflect.apply(tp.scheduler.yield, {}, [])).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_THIS' }),
    );
  });
});

describe('Lane R1b Slice 3 — tty.isatty & tty.WriteStream parity', () => {
  it('validates isatty(fd) against int32 bounds and terminal stdio, and implements WriteStream CSI/color methods', () => {
    const outChunks: string[] = [];
    const stubProcess = {
      stdin: { isTTY: true },
      stdout: {
        isTTY: true,
        columns: 120,
        rows: 40,
        write: (chunk: unknown) => {
          outChunks.push(String(chunk));
          return true;
        },
      },
      stderr: {
        isTTY: false,
        columns: undefined,
        rows: undefined,
        write: () => true,
      },
      env: { TERM: 'xterm-256color' },
    };

    const tty = createTtyBuiltin({
      process: stubProcess,
      getTerminal: () => ({ columns: 120, rows: 40 }),
    });

    expect(tty.isatty(0)).toBe(true);
    expect(tty.isatty(1)).toBe(true);
    expect(tty.isatty(2)).toBe(false);
    expect(tty.isatty(3)).toBe(false);
    expect(tty.isatty(-1)).toBe(false);
    expect(tty.isatty(1.5)).toBe(false);
    expect(tty.isatty(2147483648)).toBe(false);
    expect(Reflect.apply(tty.isatty, undefined, ['1'])).toBe(false);

    expect(() => new tty.ReadStream()).toThrowError(expect.objectContaining({ code: 'ENOSYS' }));

    const WriteStreamCtor = Reflect.get(tty, 'WriteStream');
    expect(typeof WriteStreamCtor).toBe('function');
    if (typeof WriteStreamCtor !== 'function') throw new Error('Missing WriteStream');

    expect(() => Reflect.construct(WriteStreamCtor, [-1])).toThrowError(
      expect.objectContaining({ name: 'RangeError', code: 'ERR_INVALID_FD' }),
    );

    const ws = Reflect.construct(WriteStreamCtor, [1]);
    expect(ws.isTTY).toBe(true);
    expect(ws.columns).toBe(120);
    expect(ws.rows).toBe(40);
    expect(ws.getWindowSize()).toEqual([120, 40]);
    expect(ws.getColorDepth()).toBe(8);
    expect(ws.getColorDepth({ COLORTERM: 'truecolor' })).toBe(24);
    expect(ws.getColorDepth({ NO_COLOR: '1' })).toBe(1);
    expect(ws.hasColors(256)).toBe(true);
    expect(ws.hasColors(16777216)).toBe(false);
    expect(ws.hasColors(16777216, { FORCE_COLOR: '3' })).toBe(true);

    ws.cursorTo(0);
    ws.cursorTo(4, 2);
    ws.moveCursor(-2, 3);
    ws.moveCursor(5, -1);
    ws.clearLine(-1);
    ws.clearLine(1);
    ws.clearLine(0);
    ws.clearScreenDown();

    expect(outChunks).toEqual([
      '\u001b[1G',
      '\u001b[3;5H',
      '\u001b[2D\u001b[3B',
      '\u001b[5C\u001b[1A',
      '\u001b[1K',
      '\u001b[0K',
      '\u001b[2K',
      '\u001b[0J',
    ]);
  });
});

describe('Lane R1b Slice 4 — module extras (syncBuiltinESMExports, findPackageJSON, stripTypeScriptTypes, SourceMap, constants)', () => {
  it('exposes compile cache constants/helpers, syncBuiltinESMExports, findPackageJSON, stripTypeScriptTypes, and SourceMap', () => {
    let syncCalls = 0;
    const warnings: Array<[unknown, unknown]> = [];
    const files = new Map<string, string>([
      [
        '/workspace/app/package.json',
        JSON.stringify({ name: 'demo-app', exports: { '.': './src/index.js' } }),
      ],
      ['/workspace/app/src/index.js', 'module.exports = 1;\n'],
      ['/workspace/app/src/nested/helper.js', 'module.exports = 2;\n'],
      [
        '/workspace/app/src/node_modules/local-dep/package.json',
        JSON.stringify({ name: 'local-dep', main: 'index.js' }),
      ],
      ['/workspace/app/src/node_modules/local-dep/index.js', ''],
      ['/workspace/node_modules/@scope/tool/package.json', JSON.stringify({ name: '@scope/tool' })],
      ['/orphan/script.js', 'module.exports = 0;\n'],
    ]);
    const dirs = new Set<string>([
      '/',
      '/workspace',
      '/workspace/app',
      '/workspace/app/src',
      '/workspace/app/src/nested',
      '/workspace/app/src/node_modules',
      '/workspace/app/src/node_modules/local-dep',
      '/workspace/node_modules',
      '/workspace/node_modules/@scope',
      '/workspace/node_modules/@scope/tool',
      '/orphan',
    ]);

    const fakeFs = {
      statSync(p: string) {
        if (files.has(p)) {
          return { isFile: () => true, isDirectory: () => false };
        }
        if (dirs.has(p)) {
          return { isFile: () => false, isDirectory: () => true };
        }
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      },
      readFileSync(p: string) {
        const content = files.get(p);
        if (content === undefined) {
          throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        }
        return content;
      },
    };

    const extras = createModuleExtras({
      Module: {},
      fs: fakeFs,
      cwd: () => '/workspace/app',
      isBuiltin: () => false,
      builtinModules: [],
      builtins: {},
      process: {
        emitWarning(msg: unknown, type?: unknown) {
          warnings.push([msg, type]);
        },
      },
      syncBuiltinESMExports: () => {
        syncCalls += 1;
      },
    });

    // syncBuiltinESMExports
    const syncFn = Reflect.get(extras, 'syncBuiltinESMExports');
    expect(typeof syncFn).toBe('function');
    if (typeof syncFn === 'function') syncFn();
    expect(syncCalls).toBe(1);

    // constants & compile cache safe disabled forms
    const constants = Reflect.get(extras, 'constants');
    expect(constants).toEqual({
      compileCacheStatus: {
        FAILED: 0,
        ENABLED: 1,
        ALREADY_ENABLED: 2,
        DISABLED: 3,
      },
    });
    const enableCompileCache = Reflect.get(extras, 'enableCompileCache');
    const getCompileCacheDir = Reflect.get(extras, 'getCompileCacheDir');
    const flushCompileCache = Reflect.get(extras, 'flushCompileCache');
    expect(typeof enableCompileCache).toBe('function');
    expect(typeof getCompileCacheDir).toBe('function');
    expect(typeof flushCompileCache).toBe('function');
    if (
      typeof enableCompileCache !== 'function' ||
      typeof getCompileCacheDir !== 'function' ||
      typeof flushCompileCache !== 'function'
    ) {
      throw new Error('Missing compile cache helpers');
    }
    expect(enableCompileCache()).toMatchObject({ status: 3 });
    expect(() => enableCompileCache(42)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }),
    );
    expect(getCompileCacheDir()).toBeUndefined();
    expect(flushCompileCache()).toBeUndefined();
    expect('prototype' in flushCompileCache).toBe(false);

    // findPackageJSON
    const findPackageJSON = Reflect.get(extras, 'findPackageJSON');
    expect(typeof findPackageJSON).toBe('function');
    if (typeof findPackageJSON !== 'function') throw new Error('Missing findPackageJSON');

    expect(() => findPackageJSON()).toThrowError(
      expect.objectContaining({ code: 'ERR_MISSING_ARGS' }),
    );
    expect(findPackageJSON('./helper.js', '/workspace/app/src/nested/helper.js')).toBe(
      '/workspace/app/package.json',
    );
    expect(findPackageJSON('file:///workspace/app/src/nested/helper.js')).toBe(
      '/workspace/app/package.json',
    );
    expect(findPackageJSON('local-dep', '/workspace/app/src/nested/helper.js')).toBe(
      '/workspace/app/src/node_modules/local-dep/package.json',
    );
    expect(findPackageJSON('@scope/tool/sub', 'file:///workspace/app/src/index.js')).toBe(
      '/workspace/node_modules/@scope/tool/package.json',
    );
    expect(findPackageJSON('demo-app', '/workspace/app/src/nested/helper.js')).toBe(
      '/workspace/app/package.json',
    );
    expect(findPackageJSON('file:///orphan/script.js')).toBeUndefined();
    expect(() => findPackageJSON('missing-pkg', '/workspace/app/src/index.js')).toThrowError(
      expect.objectContaining({ code: 'ERR_MODULE_NOT_FOUND' }),
    );
    expect(() => findPackageJSON('@invalid', '/workspace/app/src/index.js')).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_MODULE_SPECIFIER' }),
    );

    // stripTypeScriptTypes
    const stripTypeScriptTypes = Reflect.get(extras, 'stripTypeScriptTypes');
    expect(typeof stripTypeScriptTypes).toBe('function');
    if (typeof stripTypeScriptTypes !== 'function') throw new Error('Missing stripTypeScriptTypes');

    const tsCode = [
      'interface User { name: string; }',
      'type Id = number | string;',
      'import type { Foo } from "./foo.js";',
      'import { type Bar, baz } from "./bar.js";',
      'export function greet<T extends User>(u: T, id?: Id): string {',
      '  return (u.name as string) + String(id!);',
      '}',
    ].join('\n');
    const stripped = stripTypeScriptTypes(tsCode, { sourceUrl: 'sample.ts' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toBe('ExperimentalWarning');
    expect(stripped).toContain('export function greet                (u   , id     )         {');
    expect(stripped).toContain('import {           baz } from "./bar.js";');
    expect(stripped.endsWith('\n\n//# sourceURL=sample.ts')).toBe(true);
    // Second call must NOT re-emit experimental warning
    stripTypeScriptTypes('const n: number = 1;');
    expect(warnings).toHaveLength(1);

    expect(() => stripTypeScriptTypes('enum E { A, B }')).toThrowError(
      expect.objectContaining({ name: 'SyntaxError', code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' }),
    );
    expect(() => stripTypeScriptTypes('namespace N { export const x = 1; }')).toThrowError(
      expect.objectContaining({ name: 'SyntaxError', code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' }),
    );
    expect(() => stripTypeScriptTypes('class C { constructor(public x: number) {} }')).toThrowError(
      expect.objectContaining({ name: 'SyntaxError', code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' }),
    );
    expect(() => stripTypeScriptTypes('const x: number = 1;', { mode: 'invalid' })).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }),
    );
    expect(() =>
      stripTypeScriptTypes('const x: number = 1;', { mode: 'strip', sourceMap: true }),
    ).toThrowError(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));

    // SourceMap
    const SourceMapCtor = Reflect.get(extras, 'SourceMap');
    expect(typeof SourceMapCtor).toBe('function');
    if (typeof SourceMapCtor !== 'function') throw new Error('Missing SourceMap');

    const sm = Reflect.construct(SourceMapCtor, [
      {
        version: 3,
        file: 'out.js',
        sources: ['src.ts'],
        names: ['add'],
        mappings: 'AAAA,SAASA,IAAIC,CAAC;EAAI,OAAOA;AAAE',
      },
      { lineLengths: [30] },
    ]);
    expect(sm.payload.sources).toEqual(['src.ts']);
    expect(sm.lineLengths).toEqual([30]);
    expect(sm.findEntry(0, 9)).toEqual({
      generatedLine: 0,
      generatedColumn: 9,
      originalSource: 'src.ts',
      originalLine: 0,
      originalColumn: 9,
      name: 'add',
    });
    expect(sm.findOrigin(1, 10)).toEqual({
      name: 'add',
      fileName: 'src.ts',
      lineNumber: 1,
      columnNumber: 10,
    });
    expect(sm.findEntry(-1, 0)).toEqual({});
  });
});

describe('Lane R1b Slice 5 — lazy sys, punycode, domain, and repl builtins', () => {
  it('registers lazy getters on cold boot and provides sys (DEP0025), punycode (DEP0040), domain, and repl', async () => {
    const readline = await import('readline');
    const streamMod = await import('stream');
    const utilMod = await import('util');
    const vmMod = await import('vm');

    const emittedWarnings: Array<[string, string | undefined, string | undefined]> = [];
    const stubProcess = Object.assign(new EventEmitter(), {
      domain: null,
      env: {},
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      emitWarning(msg: unknown, type?: unknown, code?: unknown) {
        emittedWarnings.push([
          String(msg),
          typeof type === 'string' ? type : undefined,
          typeof code === 'string' ? code : undefined,
        ]);
      },
      hasUncaughtExceptionCaptureCallback: () => false,
      setUncaughtExceptionCaptureCallback: () => {},
    });

    const target: Record<string, unknown> = {};
    registerExtraLibBuiltins(target, {
      process: stubProcess,
      fs: {},
      cwd: () => '/',
      setTimeout: (fn, delay, ...args) => setTimeout(() => fn(...args), delay),
      clearTimeout: () => {},
      setImmediate: (fn, ...args) => setImmediate(() => fn(...args)),
      retain: () => {},
      release: () => {},
      util: utilMod,
      events: EventEmitter,
      readline,
      stream: streamMod,
      tty: {},
      console: {},
      asyncHooks: {},
      vm: vmMod,
      module: { builtinModules: ['fs', 'path', '_http_common'], createRequire: () => () => ({}) },
    });

    // Cold boot: zero warnings emitted before accessing lazy getters
    expect(emittedWarnings).toEqual([]);
    expect(Object.keys(target)).toEqual(['sys', 'punycode', 'domain', 'repl']);

    // 1. sys -> DEP0025 once, returns util
    const sys1 = target.sys;
    const sys2 = target.sys;
    expect(sys1).toBe(utilMod);
    expect(sys2).toBe(utilMod);
    expect(emittedWarnings.filter((w) => w[2] === 'DEP0025')).toHaveLength(1);

    // 2. punycode -> DEP0040 once, RFC 3492 parity
    const punycode = target.punycode;
    const punycodeAgain = target.punycode;
    expect(punycodeAgain).toBe(punycode);
    expect(emittedWarnings.filter((w) => w[2] === 'DEP0040')).toHaveLength(1);
    if (typeof punycode !== 'object' || punycode === null) throw new Error('Missing punycode');
    expect(Reflect.get(punycode, 'version')).toBe('2.1.0');
    const encode = Reflect.get(punycode, 'encode');
    const decode = Reflect.get(punycode, 'decode');
    const toASCII = Reflect.get(punycode, 'toASCII');
    const toUnicode = Reflect.get(punycode, 'toUnicode');
    const ucs2 = Reflect.get(punycode, 'ucs2');
    if (
      typeof encode !== 'function' ||
      typeof decode !== 'function' ||
      typeof toASCII !== 'function' ||
      typeof toUnicode !== 'function' ||
      typeof ucs2 !== 'object' ||
      ucs2 === null
    ) {
      throw new Error('Invalid punycode shape');
    }
    const ucs2Decode = Reflect.get(ucs2, 'decode');
    const ucs2Encode = Reflect.get(ucs2, 'encode');
    if (typeof ucs2Decode !== 'function' || typeof ucs2Encode !== 'function') {
      throw new Error('Invalid punycode.ucs2 shape');
    }
    expect(encode('mañana')).toBe('maana-pta');
    expect(decode('maana-pta')).toBe('mañana');
    expect(toASCII('bücher.example')).toBe('xn--bcher-kva.example');
    expect(toUnicode('xn--bcher-kva.example')).toBe('bücher.example');
    expect(ucs2Decode('𝌆')).toEqual([0x1d306]);
    expect(ucs2Encode([0x1d306])).toBe('𝌆');
    expect('prototype' in ucs2Encode).toBe(false);

    // 3. domain -> Domain, create, run, add, remove, bind, intercept, enter, exit
    const domainMod = target.domain;
    if (typeof domainMod !== 'object' || domainMod === null) throw new Error('Missing domain');
    const createDomain = Reflect.get(domainMod, 'create');
    if (typeof createDomain !== 'function') throw new Error('Missing domain.create');
    const dom = createDomain();
    expect(dom.run((a: unknown, b: unknown) => Number(a) + Number(b), 7, 8)).toBe(15);
    const domainErrors: string[] = [];
    dom.on('error', (err: Error) => domainErrors.push(err.message));
    const emitter = new EventEmitter();
    dom.add(emitter);
    expect(dom.members).toContain(emitter);
    emitter.emit('error', new Error('emitter-boom'));
    const guarded = dom.intercept((val: unknown) => `ok:${String(val)}`);
    guarded(new Error('intercept-boom'));
    expect(guarded(null, 'fine')).toBe('ok:fine');
    expect(domainErrors).toEqual(['emitter-boom', 'intercept-boom']);
    dom.remove(emitter);
    expect(dom.members).toHaveLength(0);

    // 4. repl -> REPLServer, start, Recoverable, custom PassThrough streams, defineCommand, .exit
    const replMod = target.repl;
    if (typeof replMod !== 'object' || replMod === null) throw new Error('Missing repl');
    expect(typeof Reflect.get(replMod, 'REPL_MODE_SLOPPY')).toBe('symbol');
    expect(typeof Reflect.get(replMod, 'REPL_MODE_STRICT')).toBe('symbol');
    const RecoverableCtor = Reflect.get(replMod, 'Recoverable');
    const startRepl = Reflect.get(replMod, 'start');
    if (typeof RecoverableCtor !== 'function' || typeof startRepl !== 'function') {
      throw new Error('Invalid repl shape');
    }
    const rec = Reflect.construct(RecoverableCtor, [new SyntaxError('unexpected end')]);
    expect(rec instanceof SyntaxError).toBe(true);

    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = '';
    output.on('data', (chunk) => {
      transcript += String(chunk);
    });

    const server = startRepl({
      input,
      output,
      prompt: 'unit> ',
      terminal: false,
      useColors: false,
    });
    server.defineCommand('ping', {
      help: 'Ping helper',
      action(arg: string) {
        server.clearBufferedCommand();
        server.output.write(`PONG:${arg}\n`);
        server.displayPrompt();
      },
    });

    const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
    input.write('const base = 20\n');
    input.write('base + 22\n');
    input.write('_ * 2\n');
    await new Promise((r) => setTimeout(r, 15));
    input.write('.ping world\n');
    input.write('.exit\n');
    await exited;

    expect(transcript).toContain('42');
    expect(transcript).toContain('84');
    expect(transcript).toContain('PONG:world');
  });
});
