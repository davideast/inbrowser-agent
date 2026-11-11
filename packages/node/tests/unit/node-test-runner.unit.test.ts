import { EventEmitter } from 'events';
import * as nodeAssertStrict from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as nodeStream from 'node:stream';
import * as nodeUtil from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  type TestRunnerBuiltinsDeps,
  registerTestRunnerBuiltins,
} from '../../src/builtins/test-runner';

const hostRequire = createRequire(import.meta.url);

interface HarnessEnv {
  target: Record<string, unknown>;
  deps: TestRunnerBuiltinsDeps;
  processObj: EventEmitter & {
    exitCode?: number;
    execArgv: string[];
    argv: string[];
    stdout: { write: (chunk: string) => boolean; isTTY?: boolean };
    stderr: { write: (chunk: string) => boolean; isTTY?: boolean };
    version: string;
  };
  stdoutChunks: string[];
  stderrChunks: string[];
  retainedCount: () => number;
  waitForIdle: () => Promise<void>;
  files: Map<string, string>;
}

function createMemoryFs(files: Map<string, string>): Record<string, unknown> {
  return {
    existsSync(filePath: string): boolean {
      if (files.has(filePath)) return true;
      const prefix = filePath.endsWith('/') ? filePath : `${filePath}/`;
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) return true;
      }
      return false;
    },
    readFileSync(filePath: string, _encoding?: string): string {
      const content = files.get(filePath);
      if (content === undefined) {
        const err = Object.assign(
          new Error(`ENOENT: no such file or directory, open '${filePath}'`),
          {
            code: 'ENOENT',
          },
        );
        throw err;
      }
      return content;
    },
    writeFileSync(filePath: string, data: string): void {
      files.set(filePath, String(data));
    },
    mkdirSync(_dirPath: string, _options?: unknown): void {
      // Virtual map tracks full paths directly.
    },
    statSync(filePath: string): { isFile: () => boolean; isDirectory: () => boolean } {
      if (files.has(filePath)) {
        return { isFile: () => true, isDirectory: () => false };
      }
      const prefix = filePath === '/' ? '/' : `${filePath.replace(/\/+$/, '')}/`;
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          return { isFile: () => false, isDirectory: () => true };
        }
      }
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${filePath}'`), {
        code: 'ENOENT',
      });
    },
    readdirSync(
      dirPath: string,
      options?: { withFileTypes?: boolean },
    ): Array<string | { name: string; isFile: () => boolean; isDirectory: () => boolean }> {
      const prefix = dirPath === '/' ? '/' : `${dirPath.replace(/\/+$/, '')}/`;
      const entries = new Map<string, 'file' | 'dir'>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest) continue;
        const slashIdx = rest.indexOf('/');
        if (slashIdx === -1) {
          entries.set(rest, 'file');
        } else {
          const sub = rest.slice(0, slashIdx);
          entries.set(sub, 'dir');
        }
      }
      const names = [...entries.keys()].sort();
      if (options?.withFileTypes) {
        return names.map((name) => {
          const kind = entries.get(name);
          return {
            name,
            isFile: () => kind === 'file',
            isDirectory: () => kind === 'dir',
          };
        });
      }
      return names;
    },
  };
}

function createHarnessEnv(options?: {
  execArgv?: string[];
  isTTY?: boolean;
  cwd?: string;
}): HarnessEnv {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const files = new Map<string, string>();
  let retained = 0;
  const idleResolvers: Array<() => void> = [];

  const emitter = new EventEmitter();
  const processObj = Object.assign(emitter, {
    exitCode: undefined as number | undefined,
    execArgv: options?.execArgv ?? [],
    argv: ['node'],
    version: 'v22.18.0',
    stdout: {
      isTTY: options?.isTTY ?? false,
      write(chunk: string): boolean {
        stdoutChunks.push(String(chunk));
        return true;
      },
    },
    stderr: {
      isTTY: options?.isTTY ?? false,
      write(chunk: string): boolean {
        stderrChunks.push(String(chunk));
        return true;
      },
    },
  });

  const target: Record<string, unknown> = {};
  const timersMod: Record<string, unknown> = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setImmediate: globalThis.setImmediate,
    clearImmediate: globalThis.clearImmediate,
  };
  const timersPromisesMod: Record<string, unknown> = {
    setTimeout: (delay = 0, value?: unknown) =>
      new Promise((resolve) => globalThis.setTimeout(() => resolve(value), delay)),
  };

  const deps: TestRunnerBuiltinsDeps = {
    process: processObj,
    fs: createMemoryFs(files),
    cwd: () => options?.cwd ?? '/work',
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    setInterval: (fn, delay, ...args) =>
      globalThis.setInterval(fn, typeof delay === 'number' ? delay : 1, ...args),
    clearInterval: (timer) => globalThis.clearInterval(timer as ReturnType<typeof setInterval>),
    setImmediate: (fn, ...args) => globalThis.setImmediate(fn, ...args),
    clearImmediate: (timer) => globalThis.clearImmediate(timer as ReturnType<typeof setImmediate>),
    hrtimeNs: () => process.hrtime.bigint(),
    retain: () => {
      retained += 1;
    },
    release: () => {
      retained -= 1;
      if (retained === 0) {
        while (idleResolvers.length > 0) {
          idleResolvers.shift()?.();
        }
      }
    },
    loadModule: (id: string) => {
      const bare = id.startsWith('node:') ? id.slice(5) : id;
      if (bare === 'assert/strict' || bare === 'assert') return nodeAssertStrict;
      if (bare === 'timers') return timersMod;
      if (bare === 'timers/promises') return timersPromisesMod;
      if (bare in target) return target[bare];
      return hostRequire(id);
    },
    importModule: async (specifier: string) => {
      const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
      if (bare in target) return target[bare];
      throw new Error(`Unexpected importModule(${specifier}) without virtual module setup`);
    },
    events: EventEmitter,
    stream: nodeStream,
    util: nodeUtil as unknown as Record<string, unknown>,
    asyncHooks: {},
  };

  registerTestRunnerBuiltins(target, deps);

  return {
    target,
    deps,
    processObj,
    stdoutChunks,
    stderrChunks,
    retainedCount: () => retained,
    waitForIdle: async () => {
      if (retained === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (retained === 0) return;
      }
      await new Promise<void>((resolve) => {
        idleResolvers.push(resolve);
      });
    },
    files,
  };
}

function isConstructible(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  try {
    Reflect.construct(String, [], fn);
    return true;
  } catch {
    return false;
  }
}

describe('Slice 1: Core node:test harness, lifecycle hooks, subtests & exit-code semantics', () => {
  it('registers lazy enumerable/configurable test & test/reporters builtins matching Node 22.18 descriptors', () => {
    const env = createHarnessEnv();
    const testProp = Object.getOwnPropertyDescriptor(env.target, 'test');
    const reportersProp = Object.getOwnPropertyDescriptor(env.target, 'test/reporters');
    expect(testProp?.enumerable).toBe(true);
    expect(testProp?.configurable).toBe(true);
    expect(typeof testProp?.get).toBe('function');
    expect(reportersProp?.enumerable).toBe(true);
    expect(reportersProp?.configurable).toBe(true);
    expect(typeof reportersProp?.get).toBe('function');

    const testMod = env.target.test as Record<string, unknown>;
    expect(typeof testMod).toBe('function');
    expect(isConstructible(testMod)).toBe(false);
    expect(testMod.test).toBe(testMod);
    expect(testMod.it).toBe(testMod);
    expect(testMod.describe).toBe(testMod.suite);

    for (const dataKey of [
      'skip',
      'todo',
      'only',
      'after',
      'afterEach',
      'before',
      'beforeEach',
      'describe',
      'it',
      'suite',
      'test',
    ]) {
      const desc = Object.getOwnPropertyDescriptor(testMod, dataKey);
      expect(desc, dataKey).toMatchObject({
        writable: true,
        enumerable: true,
        configurable: true,
      });
      expect(isConstructible(desc?.value), `${dataKey} constructible`).toBe(false);
    }

    const runDesc = Object.getOwnPropertyDescriptor(testMod, 'run');
    expect(runDesc).toMatchObject({ writable: true, enumerable: true, configurable: true });
    expect(isConstructible(runDesc?.value)).toBe(true);

    for (const accessorKey of ['mock', 'snapshot', 'assert']) {
      const desc = Object.getOwnPropertyDescriptor(testMod, accessorKey);
      expect(typeof desc?.get, accessorKey).toBe('function');
      expect(desc?.set, accessorKey).toBeUndefined();
      expect(desc?.enumerable, accessorKey).toBe(true);
      expect(desc?.configurable, accessorKey).toBe(true);
    }

    const assertObj = testMod.assert as Record<string, unknown>;
    expect(Object.getPrototypeOf(assertObj)).toBeNull();
    expect(isConstructible(assertObj.register)).toBe(true);
  });

  it('executes sync, async, and callback tests & hooks, nested subtests, custom assertions, and releases handles cleanly', async () => {
    const env = createHarnessEnv();
    const testMod = env.target.test as {
      (name: string, fn: (t: Record<string, unknown>) => unknown): Promise<void>;
      describe: (name: string, fn: (s: Record<string, unknown>) => void) => Promise<void>;
      it: (
        name: string,
        fn: (t: Record<string, unknown>, done?: (err?: unknown) => void) => unknown,
      ) => Promise<void>;
      before: (fn: () => unknown) => void;
      after: (fn: () => unknown) => void;
      beforeEach: (fn: (t: Record<string, unknown>) => unknown) => void;
      afterEach: (fn: (t: Record<string, unknown>) => unknown) => void;
      assert: {
        register: (
          name: string,
          fn: (this: Record<string, unknown>, value: number) => void,
        ) => void;
      };
    };

    const order: string[] = [];
    testMod.assert.register('isEven', function (value: number) {
      const assertProp = this.assert as { strictEqual: (a: unknown, b: unknown) => void };
      assertProp.strictEqual(value % 2, 0);
    });

    await testMod.describe('math suite', (s) => {
      order.push(
        `suite-ctx:${String(s.name)}:${String(s.fullName)}:${s.signal instanceof AbortSignal}`,
      );
      testMod.before(async () => {
        await Promise.resolve();
        order.push('before');
      });
      testMod.beforeEach((t) => {
        order.push(`beforeEach:${String(t.name)}:${String(t.passed)}`);
      });
      testMod.afterEach((t) => {
        order.push(`afterEach:${String(t.name)}:${String(t.passed)}`);
      });
      testMod.after(() => {
        order.push('after');
      });

      testMod.it('sync + subtest + custom assert', async (t) => {
        order.push(`run:${String(t.fullName)}:attempt=${String(t.attempt)}`);
        const assertCtx = t.assert as {
          isEven: (n: number) => void;
          strictEqual: (a: unknown, b: unknown) => void;
        };
        assertCtx.isEven(4);
        const ctxWithTest = t as {
          test: (name: string, fn: (sub: Record<string, unknown>) => void) => Promise<void>;
        };
        await ctxWithTest.test('nested child', (sub) => {
          order.push(`sub:${String(sub.fullName)}`);
          assertCtx.strictEqual(2 + 2, 4);
        });
      });

      testMod.it('callback style', (_t, done) => {
        setTimeout(() => {
          order.push('callback-done');
          done?.();
        }, 5);
      });
    });

    await env.waitForIdle();
    expect(env.retainedCount()).toBe(0);
    expect(env.processObj.exitCode).toBeUndefined();
    expect(order).toEqual([
      'suite-ctx:math suite:math suite:true',
      'before',
      'beforeEach:sync + subtest + custom assert:false',
      'run:math suite > sync + subtest + custom assert:attempt=0',
      'beforeEach:nested child:false',
      'sub:math suite > sync + subtest + custom assert > nested child',
      'afterEach:nested child:true',
      'afterEach:sync + subtest + custom assert:true',
      'beforeEach:callback style:false',
      'callback-done',
      'afterEach:callback style:true',
      'after',
    ]);
    expect(env.stdoutChunks.join('')).toContain('TAP version 13');
    expect(env.stdoutChunks.join('')).toContain('ok 1 - math suite');
  });

  it('enforces t.plan(count), timeout, skip, todo, only, and sets process.exitCode = 1 on top-level failure', async () => {
    const env = createHarnessEnv();
    const testMod = env.target.test as (
      name: string,
      options?: Record<string, unknown>,
      fn?: (t: Record<string, unknown>) => unknown,
    ) => Promise<void>;

    const observedAfterEach: Array<{ name: string; passed: boolean; code?: string }> = [];
    const afterEach = (
      env.target.test as { afterEach: (fn: (t: Record<string, unknown>) => void) => void }
    ).afterEach;
    afterEach((t) => {
      const err = t.error as { code?: string } | null;
      observedAfterEach.push({
        name: String(t.name),
        passed: Boolean(t.passed),
        code: err?.code,
      });
    });

    void testMod('plan mismatch fails', {}, (t) => {
      const ctxWithPlan = t as { plan: (n: number) => void };
      const assertCtx = t.assert as { strictEqual: (a: unknown, b: unknown) => void };
      ctxWithPlan.plan(2);
      assertCtx.strictEqual(1, 1);
    });

    void testMod('timeout fails', { timeout: 15 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    void testMod('skipped test', { skip: 'later' }, () => {
      throw new Error('should not run');
    });

    void testMod('todo failing test does not count as suite failure alone', { todo: 'wip' }, () => {
      throw new Error('known todo failure');
    });

    await env.waitForIdle();
    expect(env.retainedCount()).toBe(0);
    expect(env.processObj.exitCode).toBe(1);
    expect(observedAfterEach).toEqual([
      { name: 'plan mismatch fails', passed: false, code: 'ERR_TEST_FAILURE' },
      { name: 'timeout fails', passed: false, code: 'ERR_TEST_FAILURE' },
      {
        name: 'todo failing test does not count as suite failure alone',
        passed: false,
        code: 'ERR_TEST_FAILURE',
      },
    ]);
  });
});

describe('Slice 2: Mocking engine (MockTracker, MockFunctionContext, MockTimers, mock.module)', () => {
  it('supports mock.fn, mock.method, mock.getter, mock.setter, times, mockImplementationOnce, and auto-restores t.mock after test', async () => {
    const env = createHarnessEnv();
    const testMod = env.target.test as {
      (name: string, fn: (t: Record<string, unknown>) => unknown): Promise<void>;
      mock: {
        fn: (
          orig?: (...args: number[]) => number,
          impl?: (...args: number[]) => number,
          opts?: { times?: number },
        ) => ((...args: number[]) => number) & {
          mock: {
            calls: Array<{ arguments: number[]; result: unknown; error: unknown; this: unknown }>;
            callCount: () => number;
            mockImplementation: (fn: (...args: number[]) => number) => void;
            mockImplementationOnce: (fn: (...args: number[]) => number, onCall?: number) => void;
            resetCalls: () => void;
            restore: () => void;
          };
        };
        method: (
          obj: Record<string, unknown>,
          key: string,
          impl?: (...args: unknown[]) => unknown,
        ) => { mock: { callCount: () => number; restore: () => void } };
        getter: (obj: Record<string, unknown>, key: string, impl?: () => unknown) => unknown;
        setter: (obj: Record<string, unknown>, key: string, impl?: (v: unknown) => void) => unknown;
        restoreAll: () => void;
        reset: () => void;
      };
    };

    expect('module' in testMod.mock).toBe(false);

    const fn = testMod.mock.fn(
      (x) => x + 1,
      (x) => x * 10,
      { times: 2 },
    );
    expect(fn(3)).toBe(30);
    expect(fn(4)).toBe(40);
    expect(fn(5)).toBe(6);
    expect(fn.mock.callCount()).toBe(3);
    expect(fn.mock.calls.map((c) => ({ args: c.arguments, res: c.result }))).toEqual([
      { args: [3], res: 30 },
      { args: [4], res: 40 },
      { args: [5], res: 6 },
    ]);

    fn.mock.mockImplementationOnce((x) => x + 100);
    expect(fn(1)).toBe(101);
    expect(fn(1)).toBe(2);
    fn.mock.resetCalls();
    expect(fn.mock.callCount()).toBe(0);

    const service = {
      hidden: 5,
      compute(n: number): number {
        return n * 2;
      },
      get count(): number {
        return this.hidden;
      },
      set count(v: number) {
        this.hidden = v;
      },
    };

    await testMod('per-test t.mock auto-restores', (t) => {
      const tMock = t.mock as typeof testMod.mock;
      tMock.method(service, 'compute', () => 999);
      tMock.getter(service, 'count', () => 77);
      expect(service.compute(3)).toBe(999);
      expect(service.count).toBe(77);
    });

    await env.waitForIdle();
    expect(service.compute(3)).toBe(6);
    expect(service.count).toBe(5);
  });

  it('virtualizes timers and Date via mock.timers (enable, tick, runAll, setTime, reset, Symbol.dispose)', async () => {
    const env = createHarnessEnv();
    const testMod = env.target.test as {
      mock: {
        timers: {
          enable: (opts?: { apis?: string[]; now?: number | Date }) => void;
          tick: (ms?: number) => void;
          runAll: () => void;
          setTime: (ms?: number) => void;
          reset: () => void;
          [Symbol.dispose]: () => void;
        };
      };
    };

    const realSetTimeout = globalThis.setTimeout;
    const realDate = globalThis.Date;
    const fired: string[] = [];

    try {
      testMod.mock.timers.enable({
        apis: ['setTimeout', 'setInterval', 'setImmediate', 'Date'],
        now: 1_000,
      });
      expect(Date.now()).toBe(1_000);
      expect(new Date().getTime()).toBe(1_000);

      setImmediate(() => fired.push('imm-1'));
      const cancelledImm = setImmediate(() => fired.push('imm-cancelled'));
      clearImmediate(cancelledImm);

      setTimeout(() => fired.push('t-40'), 40);
      const cancelledTimeout = setTimeout(() => fired.push('t-cancelled'), 20);
      clearTimeout(cancelledTimeout);

      const iv = setInterval(() => fired.push(`iv@${Date.now()}`), 25);

      const timersPromises = env.deps.loadModule('node:timers/promises') as {
        setTimeout: (ms: number, val: string) => Promise<string>;
      };
      let promisedValue = '';
      void timersPromises.setTimeout(50, 'resolved-50').then((v) => {
        promisedValue = v;
      });

      testMod.mock.timers.tick(60);
      clearInterval(iv);
      await Promise.resolve();

      expect(fired).toEqual(['imm-1', 'iv@1025', 't-40', 'iv@1050']);
      expect(promisedValue).toBe('resolved-50');
      expect(Date.now()).toBe(1_060);

      setTimeout(() => fired.push(`late@${Date.now()}`), 200);
      testMod.mock.timers.runAll();
      expect(fired).toContain('late@1260');

      testMod.mock.timers.setTime(9_000);
      expect(Date.now()).toBe(9_000);

      testMod.mock.timers[Symbol.dispose]();
      expect(globalThis.setTimeout).toBe(realSetTimeout);
      expect(globalThis.Date).toBe(realDate);
    } finally {
      testMod.mock.timers.reset();
    }
  });

  it('exposes mock.module only when --experimental-test-module-mocks is enabled and restores mocked builtins', () => {
    const env = createHarnessEnv({ execArgv: ['--experimental-test-module-mocks'] });
    env.target.path = { sep: '/', join: (a: string, b: string) => `${a}/${b}` };

    const testMod = env.target.test as {
      mock: {
        module: (
          specifier: string,
          options?: { namedExports?: Record<string, unknown>; defaultExport?: unknown },
        ) => { restore: () => void };
      };
    };

    expect(typeof testMod.mock.module).toBe('function');
    const ctx = testMod.mock.module('node:path', {
      defaultExport: { sep: ':', join: (a: string, b: string) => `${a}:${b}` },
      namedExports: { sep: ':', join: (a: string, b: string) => `${a}:${b}` },
    });

    const mockedPath = env.deps.loadModule('node:path') as {
      join: (a: string, b: string) => string;
    };
    expect(mockedPath.join('x', 'y')).toBe('x:y');

    ctx.restore();
    const restoredPath = env.deps.loadModule('node:path') as {
      join: (a: string, b: string) => string;
    };
    expect(restoredPath.join('x', 'y')).toBe('x/y');
  });
});

describe('Slice 3: node:test/reporters (tap, spec, dot, junit, lcov) & TestsStream', () => {
  it('matches Node 22.18.0 property descriptors, typeof, and constructibility for all 5 reporters', () => {
    const env = createHarnessEnv();
    const reporters = env.target['test/reporters'] as Record<string, unknown>;

    for (const key of ['dot', 'junit', 'tap']) {
      const desc = Object.getOwnPropertyDescriptor(reporters, key);
      expect(typeof desc?.get, `${key} getter`).toBe('function');
      expect(desc?.set, `${key} setter`).toBeUndefined();
      expect(desc?.enumerable, `${key} enumerable`).toBe(true);
      expect(desc?.configurable, `${key} configurable`).toBe(true);
      const val = reporters[key];
      expect(typeof val, `${key} typeof`).toBe('function');
      expect(isConstructible(val), `${key} constructible`).toBe(false);
    }

    const lcovDesc = Object.getOwnPropertyDescriptor(reporters, 'lcov');
    expect(typeof lcovDesc?.get).toBe('function');
    expect(lcovDesc?.set).toBeUndefined();
    expect(lcovDesc?.enumerable).toBe(true);
    expect(lcovDesc?.configurable).toBe(true);
    const lcovA = reporters.lcov;
    const lcovB = reporters.lcov;
    expect(typeof lcovA).toBe('object');
    expect(lcovA).not.toBeNull();
    expect(lcovA).not.toBe(lcovB);

    const specDesc = Object.getOwnPropertyDescriptor(reporters, 'spec');
    expect(specDesc?.writable).toBe(false);
    expect(specDesc?.enumerable).toBe(true);
    expect(specDesc?.configurable).toBe(true);
    expect(typeof specDesc?.value).toBe('function');
    expect(isConstructible(specDesc?.value)).toBe(true);

    const specFn = reporters.spec as { (): unknown; new (): unknown };
    expect(typeof specFn()).toBe('object');
    expect(typeof new specFn()).toBe('object');
  });

  it('formats synthetic event streams across tap, spec, dot, junit, and lcov via .compose() and for-await', async () => {
    const env = createHarnessEnv();
    const reporters = env.target['test/reporters'] as {
      tap: (source: AsyncIterable<unknown>) => AsyncGenerator<string>;
      dot: (source: AsyncIterable<unknown>) => AsyncGenerator<string>;
      junit: (source: AsyncIterable<unknown>) => AsyncGenerator<string>;
      spec: new () => nodeStream.Transform;
      lcov: nodeStream.Transform;
    };

    const sampleEvents = [
      { type: 'test:start', data: { nesting: 0, name: 'suite <alpha>' } },
      { type: 'test:start', data: { nesting: 1, name: 'passes' } },
      {
        type: 'test:pass',
        data: {
          name: 'passes',
          nesting: 1,
          testNumber: 1,
          details: { duration_ms: 1.5, type: 'test' },
        },
      },
      { type: 'test:diagnostic', data: { nesting: 1, message: 'note & detail' } },
      { type: 'test:start', data: { nesting: 1, name: 'fails' } },
      {
        type: 'test:fail',
        data: {
          name: 'fails',
          nesting: 1,
          testNumber: 2,
          details: { duration_ms: 2.0, type: 'test', error: new Error('bad <value>') },
        },
      },
      { type: 'test:plan', data: { nesting: 1, count: 2 } },
      {
        type: 'test:fail',
        data: {
          name: 'suite <alpha>',
          nesting: 0,
          testNumber: 1,
          details: { duration_ms: 4.0, type: 'suite', error: new Error('1 subtest failed') },
        },
      },
      { type: 'test:plan', data: { nesting: 0, count: 1 } },
      {
        type: 'test:coverage',
        data: {
          nesting: 0,
          summary: {
            workingDirectory: '/work',
            files: [
              {
                path: '/work/lib/math.js',
                totalLineCount: 2,
                totalBranchCount: 1,
                totalFunctionCount: 1,
                coveredLineCount: 2,
                coveredBranchCount: 1,
                coveredFunctionCount: 1,
                coveredLinePercent: 100,
                coveredBranchPercent: 100,
                coveredFunctionPercent: 100,
                functions: [{ name: 'add', line: 1, count: 4 }],
                branches: [{ line: 1, count: 4 }],
                lines: [
                  { line: 1, count: 4 },
                  { line: 2, count: 4 },
                ],
              },
            ],
          },
        },
      },
    ];

    const collectComposed = async (rep: unknown): Promise<string> => {
      const composed = nodeStream.Readable.from(sampleEvents).compose(
        rep as Parameters<nodeStream.Readable['compose']>[0],
      );
      let out = '';
      for await (const chunk of composed) {
        out += String(chunk);
      }
      return out;
    };

    const tapOut = await collectComposed(reporters.tap);
    expect(tapOut).toContain('TAP version 13');
    expect(tapOut).toContain('ok 1 - passes');
    expect(tapOut).toContain('not ok 2 - fails');
    expect(tapOut).toContain('1..1');

    const dotOut = await collectComposed(reporters.dot);
    expect(dotOut).toContain('.X');

    const specOut = await collectComposed(new reporters.spec());
    expect(specOut).toContain('✔ passes');
    expect(specOut).toContain('✖ fails');
    expect(specOut).toContain('ℹ note & detail');

    const junitOut = await collectComposed(reporters.junit);
    expect(junitOut).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(junitOut).toContain('<testsuite name="suite &lt;alpha&gt;"');
    expect(junitOut).toContain('<failure');
    expect(junitOut).toContain('bad &lt;value&gt;');

    const lcovOut = await collectComposed(reporters.lcov);
    expect(lcovOut).toContain('SF:lib/math.js');
    expect(lcovOut).toContain('FN:1,add');
    expect(lcovOut).toContain('FNDA:4,add');
    expect(lcovOut).toContain('DA:1,4');
    expect(lcovOut).toContain('end_of_record');
  });
});

describe('Slice 4: Programmatic run(options?) & snapshot / fileSnapshot', () => {
  it('discovers virtual fs test files in run(), executes setup + in-process files, and streams to reporters', async () => {
    const env = createHarnessEnv({ cwd: '/work' });
    env.files.set('/work/src/add.test.cjs', 'add-test');
    env.files.set('/work/test/sub.test.mjs', 'sub-test');
    env.files.set('/work/node_modules/pkg/ignored.test.js', 'ignored');
    env.files.set('/work/src/helper.js', 'not-a-test');

    const testMod = env.target.test as {
      (name: string, fn: (t: Record<string, unknown>) => unknown): Promise<void>;
      run: (options?: Record<string, unknown>) => AsyncIterable<{ type: string; data: unknown }> & {
        compose: (rep: unknown) => AsyncIterable<string>;
        on: (event: string, listener: (data: unknown) => void) => void;
      };
    };
    const reporters = env.target['test/reporters'] as {
      spec: new () => unknown;
    };

    const origLoadModule = env.deps.loadModule;
    env.deps.loadModule = (id: string, parent?: string) => {
      if (id === '/work/src/add.test.cjs') {
        void testMod('cjs discovered test', (t) => {
          const assertCtx = t.assert as { strictEqual: (a: unknown, b: unknown) => void };
          assertCtx.strictEqual(10 + 5, 15);
        });
        return {};
      }
      return origLoadModule(id, parent);
    };
    env.deps.importModule = async (specifier: string) => {
      if (
        specifier === '/work/test/sub.test.mjs' ||
        specifier.endsWith('/work/test/sub.test.mjs')
      ) {
        void testMod('esm discovered test', (t) => {
          const assertCtx = t.assert as { strictEqual: (a: unknown, b: unknown) => void };
          assertCtx.strictEqual('a' + 'b', 'ab');
        });
        return {};
      }
      throw new Error(`Unexpected import: ${specifier}`);
    };

    let setupCalled = false;
    const summaryEvents: unknown[] = [];
    const stream = testMod.run({
      cwd: '/work',
      setup: async () => {
        setupCalled = true;
      },
    });
    stream.on('test:summary', (data) => {
      summaryEvents.push(data);
    });

    const composed = stream.compose(new reporters.spec());
    let specOutput = '';
    for await (const chunk of composed) {
      specOutput += String(chunk);
    }

    expect(setupCalled).toBe(true);
    expect(env.retainedCount()).toBe(0);
    expect(specOutput).toContain('cjs discovered test');
    expect(specOutput).toContain('esm discovered test');
    expect(specOutput).not.toContain('ignored');
    expect(summaryEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('writes and verifies .snapshot files and fileSnapshot via virtual fs with custom serializers', async () => {
    const sharedFiles = new Map<string, string>();
    const writeEnv = createHarnessEnv({
      cwd: '/work',
      execArgv: ['--test-update-snapshots'],
    });
    for (const [k, v] of sharedFiles) writeEnv.files.set(k, v);

    const writeTestMod = writeEnv.target.test as {
      (name: string, fn: (t: Record<string, unknown>) => unknown): Promise<void>;
      snapshot: {
        setDefaultSnapshotSerializers: (s: Array<(v: unknown) => string>) => void;
        setResolveSnapshotPath: (fn: (p: string | undefined) => string) => void;
      };
    };

    writeTestMod.snapshot.setResolveSnapshotPath(
      (testPath) => `${testPath ?? '/work/inline.test.js'}.snapshot`,
    );
    writeTestMod.snapshot.setDefaultSnapshotSerializers([
      (value) => `SERIALIZED:${JSON.stringify(value)}`,
    ]);

    await writeTestMod('snapshot roundtrip', (t) => {
      const assertCtx = t.assert as {
        snapshot: (val: unknown) => void;
        fileSnapshot: (val: unknown, path: string) => void;
      };
      assertCtx.snapshot({ msg: 'hello `ticks` ${expr}' });
      assertCtx.fileSnapshot({ raw: 42 }, '/work/snapshots/custom.snap');
    });
    await writeEnv.waitForIdle();
    expect(writeEnv.processObj.exitCode).toBeUndefined();

    const snapContent = writeEnv.files.get('/work/inline.test.js.snapshot');
    expect(snapContent).toContain('exports[`snapshot roundtrip 1`] = `');
    expect(snapContent).toContain('SERIALIZED:');
    expect(writeEnv.files.get('/work/snapshots/custom.snap')).toContain('SERIALIZED:{"raw":42}');

    // Now run in read-only verification mode (no --test-update-snapshots) against the saved files!
    const verifyEnv = createHarnessEnv({ cwd: '/work' });
    for (const [k, v] of writeEnv.files.entries()) {
      verifyEnv.files.set(k, v);
    }
    const verifyTestMod = verifyEnv.target.test as typeof writeTestMod;
    verifyTestMod.snapshot.setResolveSnapshotPath(
      (testPath) => `${testPath ?? '/work/inline.test.js'}.snapshot`,
    );
    verifyTestMod.snapshot.setDefaultSnapshotSerializers([
      (value) => `SERIALIZED:${JSON.stringify(value)}`,
    ]);

    await verifyTestMod('snapshot roundtrip', (t) => {
      const assertCtx = t.assert as {
        snapshot: (val: unknown) => void;
        fileSnapshot: (val: unknown, path: string) => void;
      };
      assertCtx.snapshot({ msg: 'hello `ticks` ${expr}' });
      assertCtx.fileSnapshot({ raw: 42 }, '/work/snapshots/custom.snap');
    });
    await verifyEnv.waitForIdle();
    expect(verifyEnv.processObj.exitCode).toBeUndefined();

    // Now verify mismatch fails with exitCode = 1
    await verifyTestMod('snapshot roundtrip', (t) => {
      const assertCtx = t.assert as { snapshot: (val: unknown) => void };
      assertCtx.snapshot({ msg: 'CHANGED!' });
    });
    await verifyEnv.waitForIdle();
    expect(verifyEnv.processObj.exitCode).toBe(1);
  });

  it('emits all documented TestsStream named events and supports shard + pattern filtering in run()', async () => {
    const env = createHarnessEnv({ cwd: '/work' });
    env.files.set('/work/a.test.cjs', 'a');
    env.files.set('/work/b.test.cjs', 'b');

    const testMod = env.target.test as {
      (name: string, fn: (t: Record<string, unknown>) => unknown): Promise<void>;
      run: (options?: Record<string, unknown>) => AsyncIterable<{ type: string; data: unknown }> & {
        on: (event: string, listener: (data: unknown) => void) => void;
        emitEvent: (ev: { type: string; data: unknown }) => void;
      };
    };

    const origLoad = env.deps.loadModule;
    env.deps.loadModule = (id: string, parent?: string) => {
      if (id === '/work/a.test.cjs') {
        void testMod('alpha match', (t) => {
          (t as { diagnostic: (m: string) => void }).diagnostic('diag-a');
        });
        void testMod('alpha fail', () => {
          throw new Error('intentional');
        });
        return {};
      }
      if (id === '/work/b.test.cjs') {
        void testMod('beta skipped by shard', () => {});
        return {};
      }
      return origLoad(id, parent);
    };

    const observedNamedEvents = new Set<string>();
    const stream = testMod.run({
      cwd: '/work',
      shard: { index: 1, total: 2 },
      watch: true,
      setup: (root: { emitEvent: (ev: { type: string; data: unknown }) => void }) => {
        root.emitEvent({ type: 'test:stdout', data: { file: '/work/a.test.cjs', message: 'out' } });
        root.emitEvent({ type: 'test:stderr', data: { file: '/work/a.test.cjs', message: 'err' } });
        root.emitEvent({
          type: 'test:coverage',
          data: { nesting: 0, summary: { workingDirectory: '/work', files: [] } },
        });
      },
    });

    for (const evName of [
      'test:enqueue',
      'test:dequeue',
      'test:start',
      'test:pass',
      'test:fail',
      'test:complete',
      'test:plan',
      'test:diagnostic',
      'test:stdout',
      'test:stderr',
      'test:coverage',
      'test:summary',
      'test:watch:drained',
    ]) {
      stream.on(evName, () => {
        observedNamedEvents.add(evName);
      });
    }

    const streamedItems: string[] = [];
    for await (const item of stream) {
      streamedItems.push(item.type);
    }

    expect([...observedNamedEvents].sort()).toEqual([
      'test:complete',
      'test:coverage',
      'test:dequeue',
      'test:diagnostic',
      'test:enqueue',
      'test:fail',
      'test:pass',
      'test:plan',
      'test:start',
      'test:stderr',
      'test:stdout',
      'test:summary',
      'test:watch:drained',
    ]);
    expect(streamedItems).toContain('test:watch:drained');
  });
});
