import type { TestRunnerBuiltinsDeps } from '../builtins/test-runner';
import {
  createInvalidArgType,
  createInvalidArgValue,
  createInvalidState,
  getProcessExecArgv,
  isRecord,
} from './types';

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

function isAnyFn(value: unknown): value is AnyFn {
  return typeof value === 'function';
}

function readRawTimesOption(record: Record<string, unknown>): { times?: number } {
  if (!('times' in record) || record.times === undefined) return {};
  const times = validateTimesOption(record.times);
  return { times };
}

export interface MockCallRecord {
  arguments: unknown[];
  error: unknown;
  result: unknown;
  stack: Error;
  target: unknown;
  this: unknown;
}

export interface MockFunctionOptions {
  times?: number;
}

export interface MockMethodOptions extends MockFunctionOptions {
  getter?: boolean;
  setter?: boolean;
}

function validateTimesOption(times: unknown): number | undefined {
  if (times === undefined) return undefined;
  if (typeof times !== 'number' || !Number.isInteger(times) || times < 1) {
    throw createInvalidArgValue('options.times', times, 'must be an integer greater than 0');
  }
  return times;
}

export class MockFunctionContext {
  readonly #calls: MockCallRecord[] = [];
  readonly #original: AnyFn;
  #implementation: AnyFn;
  #remainingTimes: number | undefined;
  readonly #onceImplementations = new Map<number, AnyFn>();

  constructor(original: AnyFn, implementation: AnyFn, times: number | undefined) {
    this.#original = original;
    this.#implementation = implementation;
    this.#remainingTimes = times;
  }

  get calls(): MockCallRecord[] {
    return this.#calls.slice();
  }

  callCount(): number {
    return this.#calls.length;
  }

  mockImplementation(implementation: AnyFn): void {
    if (typeof implementation !== 'function') {
      throw createInvalidArgType('implementation', 'Function', implementation);
    }
    this.#implementation = implementation;
    this.#remainingTimes = undefined;
  }

  mockImplementationOnce(implementation: AnyFn, onCall?: number): void {
    if (typeof implementation !== 'function') {
      throw createInvalidArgType('implementation', 'Function', implementation);
    }
    const currentCallCount = this.#calls.length;
    let targetCall = currentCallCount;
    if (onCall !== undefined) {
      if (typeof onCall !== 'number' || !Number.isInteger(onCall) || onCall < currentCallCount) {
        throw createInvalidArgValue(
          'onCall',
          onCall,
          `must be an integer greater than or equal to ${currentCallCount}`,
        );
      }
      targetCall = onCall;
    } else {
      while (this.#onceImplementations.has(targetCall)) {
        targetCall += 1;
      }
    }
    this.#onceImplementations.set(targetCall, implementation);
  }

  restore(): void {
    this.#implementation = this.#original;
    this.#remainingTimes = undefined;
    this.#onceImplementations.clear();
  }

  resetCalls(): void {
    this.#calls.length = 0;
  }

  invoke(thisArg: unknown, args: unknown[], newTarget: unknown): unknown {
    const callIdx = this.#calls.length;
    let activeFn: AnyFn;
    const onceFn = this.#onceImplementations.get(callIdx);
    if (onceFn !== undefined) {
      this.#onceImplementations.delete(callIdx);
      activeFn = onceFn;
    } else if (this.#remainingTimes !== undefined) {
      if (this.#remainingTimes > 0) {
        this.#remainingTimes -= 1;
        activeFn = this.#implementation;
        if (this.#remainingTimes === 0) {
          this.#implementation = this.#original;
          this.#remainingTimes = undefined;
        }
      } else {
        activeFn = this.#original;
      }
    } else {
      activeFn = this.#implementation;
    }

    const stack = new Error();
    const baseRecord: Record<string, unknown> = Object.create(null);
    const record: MockCallRecord = Object.assign(baseRecord, {
      arguments: args,
      error: undefined,
      result: undefined,
      stack,
      target: newTarget,
      this: thisArg,
    });
    this.#calls.push(record);

    try {
      const result =
        newTarget !== undefined
          ? Reflect.construct(
              activeFn,
              args,
              typeof newTarget === 'function' ? newTarget : activeFn,
            )
          : Reflect.apply(activeFn, thisArg, args);
      record.result = result;
      return result;
    } catch (err) {
      record.error = err;
      throw err;
    }
  }
}

function createMockProxy(
  baseFn: AnyFn,
  ctx: MockFunctionContext,
): AnyFn & { mock: MockFunctionContext } {
  const proxy = new Proxy(baseFn, {
    apply(_target, thisArg, argArray) {
      return ctx.invoke(thisArg, argArray, undefined);
    },
    construct(_target, argArray, newTarget) {
      const out = ctx.invoke(undefined, argArray, newTarget);
      return isRecord(out) || typeof out === 'function' ? out : {};
    },
    get(target, prop, receiver) {
      if (prop === 'mock') return ctx;
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (prop === 'mock') return true;
      return Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'mock') {
        return {
          value: ctx,
          writable: false,
          enumerable: false,
          configurable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  // Invariant: Proxy over baseFn intercepts .mock reads with ctx.
  return proxy as AnyFn & { mock: MockFunctionContext };
}

type TimerApiName = 'setTimeout' | 'setInterval' | 'setImmediate' | 'Date';
const SUPPORTED_TIMER_APIS = new Set<string>(['setTimeout', 'setInterval', 'setImmediate', 'Date']);

interface ScheduledMockTimer {
  id: number;
  runAt: number;
  order: number;
  interval: number | undefined;
  callback: (...args: unknown[]) => void;
  args: unknown[];
  cleared: boolean;
  refed: boolean;
}

class MockTimerHandle {
  readonly #entry: ScheduledMockTimer;
  constructor(entry: ScheduledMockTimer) {
    this.#entry = entry;
  }
  get entry(): ScheduledMockTimer {
    return this.#entry;
  }
  hasRef(): boolean {
    return this.#entry.refed;
  }
  ref(): this {
    this.#entry.refed = true;
    return this;
  }
  unref(): this {
    this.#entry.refed = false;
    return this;
  }
  refresh(): this {
    return this;
  }
  [Symbol.dispose](): void {
    this.#entry.cleared = true;
  }
}

interface SavedPropertyPatch {
  holder: object;
  key: PropertyKey;
  descriptor: PropertyDescriptor | undefined;
}

export interface MockTimersEnableOptions {
  apis?: ReadonlyArray<TimerApiName>;
  now?: number | Date;
}

export class MockTimers {
  readonly #deps: TestRunnerBuiltinsDeps;
  #enabled = false;
  #now = 0;
  #nextId = 1;
  #nextOrder = 1;
  readonly #queue: ScheduledMockTimer[] = [];
  readonly #patches: SavedPropertyPatch[] = [];

  constructor(deps: TestRunnerBuiltinsDeps) {
    this.#deps = deps;
  }

  enable(options?: MockTimersEnableOptions | ReadonlyArray<TimerApiName>): void {
    if (this.#enabled) {
      throw createInvalidState('MockTimers is already enabled');
    }

    let apis: ReadonlyArray<string> = ['setTimeout', 'setInterval', 'setImmediate', 'Date'];
    let initialNow = 0;

    if (Array.isArray(options)) {
      apis = options;
    } else if (options !== undefined) {
      if (!isRecord(options)) {
        throw createInvalidArgType('options', 'Object', options);
      }
      if (options.apis !== undefined) {
        if (!Array.isArray(options.apis)) {
          throw createInvalidArgType('options.apis', 'Array', options.apis);
        }
        apis = options.apis;
      }
      if (options.now !== undefined) {
        if (options.now instanceof Date) {
          const ts = options.now.getTime();
          if (Number.isNaN(ts) || ts < 0) {
            throw createInvalidArgValue('options.now', options.now, 'must be a non-negative epoch');
          }
          initialNow = ts;
        } else if (
          typeof options.now === 'number' &&
          Number.isFinite(options.now) &&
          options.now >= 0
        ) {
          initialNow = options.now;
        } else {
          throw createInvalidArgType('options.now', 'number or Date', options.now);
        }
      }
    }

    const enabledSet = new Set<TimerApiName>();
    for (const api of apis) {
      if (typeof api !== 'string' || !SUPPORTED_TIMER_APIS.has(api)) {
        throw createInvalidArgValue(
          'options.apis',
          api,
          'must be one of setTimeout, setInterval, setImmediate, Date',
        );
      }
      // Invariant: validated api against SUPPORTED_TIMER_APIS above.
      enabledSet.add(api as TimerApiName);
    }

    this.#enabled = true;
    this.#now = initialNow;
    this.#queue.length = 0;

    const patchProperty = (holder: object, key: PropertyKey, value: unknown): void => {
      const existing = Object.getOwnPropertyDescriptor(holder, key);
      this.#patches.push({ holder, key, descriptor: existing });
      Object.defineProperty(holder, key, {
        value,
        writable: true,
        enumerable: existing?.enumerable ?? true,
        configurable: true,
      });
    };

    let timersMod: Record<string, unknown> | undefined;
    let timersPromisesMod: Record<string, unknown> | undefined;
    try {
      const mod = this.#deps.loadModule('node:timers');
      if (isRecord(mod)) timersMod = mod;
    } catch {
      // Optional in isolated test stubs.
    }
    try {
      const mod = this.#deps.loadModule('node:timers/promises');
      if (isRecord(mod)) timersPromisesMod = mod;
    } catch {
      // Optional in isolated test stubs.
    }

    if (enabledSet.has('setTimeout')) {
      const mockSetTimeout = (
        callback: (...args: unknown[]) => void,
        delay = 0,
        ...args: unknown[]
      ): MockTimerHandle => {
        if (typeof callback !== 'function') {
          throw createInvalidArgType('callback', 'Function', callback);
        }
        const normalizedDelay =
          typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? delay : 0;
        return this.#schedule(callback, this.#now + normalizedDelay, undefined, args);
      };
      const mockClearTimeout = (handle: unknown): void => {
        this.#cancelHandle(handle);
      };

      patchProperty(globalThis, 'setTimeout', mockSetTimeout);
      patchProperty(globalThis, 'clearTimeout', mockClearTimeout);
      if (timersMod) {
        patchProperty(timersMod, 'setTimeout', mockSetTimeout);
        patchProperty(timersMod, 'clearTimeout', mockClearTimeout);
      }
      if (timersPromisesMod) {
        const mockPromisesSetTimeout = (
          delay = 0,
          value?: unknown,
          opts?: { signal?: AbortSignal },
        ): Promise<unknown> =>
          new Promise((resolve, reject) => {
            if (opts?.signal?.aborted) {
              const abortErr = Object.assign(new Error('The operation was aborted'), {
                code: 'ABORT_ERR',
                name: 'AbortError',
              });
              reject(abortErr);
              return;
            }
            const handle = mockSetTimeout(() => resolve(value), delay);
            opts?.signal?.addEventListener(
              'abort',
              () => {
                mockClearTimeout(handle);
                const abortErr = Object.assign(new Error('The operation was aborted'), {
                  code: 'ABORT_ERR',
                  name: 'AbortError',
                });
                reject(abortErr);
              },
              { once: true },
            );
          });
        patchProperty(timersPromisesMod, 'setTimeout', mockPromisesSetTimeout);
        if (isRecord(timersPromisesMod.scheduler)) {
          patchProperty(
            timersPromisesMod.scheduler,
            'wait',
            (delay = 0, opts?: { signal?: AbortSignal }) =>
              mockPromisesSetTimeout(delay, undefined, opts),
          );
        }
      }
    }

    if (enabledSet.has('setInterval')) {
      const mockSetInterval = (
        callback: (...args: unknown[]) => void,
        delay = 1,
        ...args: unknown[]
      ): MockTimerHandle => {
        if (typeof callback !== 'function') {
          throw createInvalidArgType('callback', 'Function', callback);
        }
        const interval =
          typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? delay : 1;
        return this.#schedule(callback, this.#now + interval, interval, args);
      };
      const mockClearInterval = (handle: unknown): void => {
        this.#cancelHandle(handle);
      };

      patchProperty(globalThis, 'setInterval', mockSetInterval);
      patchProperty(globalThis, 'clearInterval', mockClearInterval);
      if (timersMod) {
        patchProperty(timersMod, 'setInterval', mockSetInterval);
        patchProperty(timersMod, 'clearInterval', mockClearInterval);
      }
    }

    if (enabledSet.has('setImmediate')) {
      const mockSetImmediate = (
        callback: (...args: unknown[]) => void,
        ...args: unknown[]
      ): MockTimerHandle => {
        if (typeof callback !== 'function') {
          throw createInvalidArgType('callback', 'Function', callback);
        }
        return this.#schedule(callback, this.#now, undefined, args);
      };
      const mockClearImmediate = (handle: unknown): void => {
        this.#cancelHandle(handle);
      };

      patchProperty(globalThis, 'setImmediate', mockSetImmediate);
      patchProperty(globalThis, 'clearImmediate', mockClearImmediate);
      if (timersMod) {
        patchProperty(timersMod, 'setImmediate', mockSetImmediate);
        patchProperty(timersMod, 'clearImmediate', mockClearImmediate);
      }
      if (timersPromisesMod && 'setImmediate' in timersPromisesMod) {
        patchProperty(
          timersPromisesMod,
          'setImmediate',
          (value?: unknown) =>
            new Promise((resolve) => {
              mockSetImmediate(() => resolve(value));
            }),
        );
      }
    }

    if (enabledSet.has('Date')) {
      const RealDate = globalThis.Date;
      const getNow = (): number => this.#now;
      const MockDate = new Proxy(RealDate, {
        construct(target, argArray, newTarget) {
          if (argArray.length === 0) {
            return Reflect.construct(target, [getNow()], newTarget);
          }
          return Reflect.construct(target, argArray, newTarget);
        },
        apply(target) {
          return new target(getNow()).toString();
        },
        get(target, prop, receiver) {
          if (prop === 'now') {
            return () => getNow();
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      patchProperty(globalThis, 'Date', MockDate);
    }
  }

  tick(milliseconds = 1): void {
    this.#ensureEnabled();
    if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) {
      throw createInvalidArgValue('milliseconds', milliseconds, 'must be a non-negative number');
    }
    const targetTime = this.#now + milliseconds;
    this.#advanceTo(targetTime, false);
    this.#now = targetTime;
  }

  runAll(): void {
    this.#ensureEnabled();
    this.#advanceTo(Number.POSITIVE_INFINITY, true);
  }

  setTime(milliseconds: number): void {
    this.#ensureEnabled();
    if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) {
      throw createInvalidArgValue('milliseconds', milliseconds, 'must be a non-negative number');
    }
    this.#now = milliseconds;
  }

  reset(): void {
    if (!this.#enabled) return;
    for (let i = this.#patches.length - 1; i >= 0; i -= 1) {
      const patch = this.#patches[i];
      if (patch.descriptor === undefined) {
        Reflect.deleteProperty(patch.holder, patch.key);
      } else {
        Object.defineProperty(patch.holder, patch.key, patch.descriptor);
      }
    }
    this.#patches.length = 0;
    this.#queue.length = 0;
    this.#enabled = false;
    this.#now = 0;
  }

  [Symbol.dispose](): void {
    this.reset();
  }

  #ensureEnabled(): void {
    if (!this.#enabled) {
      throw createInvalidState(
        'You should enable MockTimers first by calling the .enable function',
      );
    }
  }

  #schedule(
    callback: (...args: unknown[]) => void,
    runAt: number,
    interval: number | undefined,
    args: unknown[],
  ): MockTimerHandle {
    const entry: ScheduledMockTimer = {
      id: this.#nextId++,
      runAt,
      order: this.#nextOrder++,
      interval,
      callback,
      args,
      cleared: false,
      refed: true,
    };
    this.#insertSorted(entry);
    return new MockTimerHandle(entry);
  }

  #insertSorted(entry: ScheduledMockTimer): void {
    let idx = this.#queue.length;
    while (idx > 0) {
      const prev = this.#queue[idx - 1];
      if (prev.runAt < entry.runAt || (prev.runAt === entry.runAt && prev.order <= entry.order)) {
        break;
      }
      idx -= 1;
    }
    this.#queue.splice(idx, 0, entry);
  }

  #cancelHandle(handle: unknown): void {
    if (handle instanceof MockTimerHandle) {
      handle.entry.cleared = true;
    }
  }

  #advanceTo(limitTime: number, stopIntervalLoop: boolean): void {
    const maxIterations = 10_000;
    let iterations = 0;
    while (this.#queue.length > 0) {
      const next = this.#queue[0];
      if (next.cleared) {
        this.#queue.shift();
        continue;
      }
      if (next.runAt > limitTime) {
        break;
      }
      this.#queue.shift();
      this.#now = next.runAt;
      iterations += 1;
      if (iterations > maxIterations) {
        throw createInvalidState('MockTimers exceeded maximum synchronous timer iterations');
      }
      if (next.interval !== undefined && !next.cleared && !stopIntervalLoop) {
        next.runAt = this.#now + next.interval;
        next.order = this.#nextOrder++;
        this.#insertSorted(next);
      }
      next.callback(...next.args);
    }
  }
}

const nodejsDispose: symbol = Symbol.for('nodejs.dispose');
const standardDispose: symbol | undefined = Symbol.dispose;
if (nodejsDispose !== standardDispose) {
  Object.defineProperty(MockTimers.prototype, nodejsDispose, {
    value: MockTimers.prototype[Symbol.dispose],
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

export class MockModuleContext {
  readonly #restoreFn: () => void;
  #restored = false;

  constructor(restoreFn: () => void) {
    this.#restoreFn = restoreFn;
  }

  restore(): void {
    if (this.#restored) return;
    this.#restored = true;
    this.#restoreFn();
  }
}

export interface MockModuleOptions {
  cache?: boolean;
  defaultExport?: unknown;
  namedExports?: Record<string, unknown>;
}

interface RestorableProperty {
  target: object;
  key: PropertyKey;
  hadOwn: boolean;
  descriptor: PropertyDescriptor | undefined;
}

export class MockTracker {
  protected readonly deps: TestRunnerBuiltinsDeps;
  protected readonly builtinsTarget: Record<string, unknown> | undefined;
  #timers: MockTimers | undefined;
  readonly #contexts: MockFunctionContext[] = [];
  readonly #propertyRestores: RestorableProperty[] = [];
  readonly #moduleContexts: MockModuleContext[] = [];

  constructor(deps: TestRunnerBuiltinsDeps, builtinsTarget?: Record<string, unknown>) {
    this.deps = deps;
    this.builtinsTarget = builtinsTarget;
  }

  get timers(): MockTimers {
    this.#timers ??= new MockTimers(this.deps);
    return this.#timers;
  }

  fn(
    original?: unknown,
    implementation?: unknown,
    options?: MockFunctionOptions,
  ): AnyFn & { mock: MockFunctionContext } {
    let origFn: AnyFn = () => undefined;
    let implFn: AnyFn | undefined;
    let opts: MockFunctionOptions | undefined;

    if (original !== undefined) {
      if (isRecord(original)) {
        opts = readRawTimesOption(original);
      } else if (isAnyFn(original)) {
        origFn = original;
      } else {
        throw createInvalidArgType('original', 'Function', original);
      }
    }

    if (implementation !== undefined) {
      if (isRecord(implementation) && opts === undefined) {
        opts = readRawTimesOption(implementation);
      } else if (isAnyFn(implementation)) {
        implFn = implementation;
      } else {
        throw createInvalidArgType('implementation', 'Function', implementation);
      }
    }

    if (options !== undefined) {
      if (!isRecord(options)) {
        throw createInvalidArgType('options', 'Object', options);
      }
      opts = options;
    }

    const times = validateTimesOption(opts?.times);
    const activeImpl = implFn ?? origFn;
    const ctx = new MockFunctionContext(origFn, activeImpl, times);
    this.#contexts.push(ctx);
    return createMockProxy(origFn, ctx);
  }

  method(
    object: unknown,
    methodName: PropertyKey,
    implementation?: unknown,
    options?: MockMethodOptions,
  ): AnyFn & { mock: MockFunctionContext } {
    if ((typeof object !== 'object' || object === null) && typeof object !== 'function') {
      throw createInvalidArgType('object', 'Object or Function', object);
    }
    if (typeof methodName !== 'string' && typeof methodName !== 'symbol') {
      throw createInvalidArgType('methodName', 'string or symbol', methodName);
    }

    let implFn: AnyFn | undefined;
    let optsRecord: Record<string, unknown> = {};

    if (implementation !== undefined) {
      if (isRecord(implementation) && options === undefined) {
        optsRecord = implementation;
      } else if (isAnyFn(implementation)) {
        implFn = implementation;
      } else {
        throw createInvalidArgType('implementation', 'Function', implementation);
      }
    }
    if (options !== undefined) {
      if (!isRecord(options)) {
        throw createInvalidArgType('options', 'Object', options);
      }
      optsRecord = options;
    }

    const isGetter = Boolean(optsRecord.getter);
    const isSetter = Boolean(optsRecord.setter);
    if (isGetter && isSetter) {
      throw createInvalidArgValue(
        'options.setter',
        optsRecord.setter,
        "cannot be used with 'options.getter'",
      );
    }

    const ownDesc = Object.getOwnPropertyDescriptor(object, methodName);
    let protoHolder: object | null = object;
    let resolvedDesc = ownDesc;
    while (!resolvedDesc && protoHolder !== null) {
      protoHolder = Object.getPrototypeOf(protoHolder);
      if (protoHolder !== null) {
        resolvedDesc = Object.getOwnPropertyDescriptor(protoHolder, methodName);
      }
    }

    if (!resolvedDesc) {
      throw createInvalidArgValue(
        'methodName',
        methodName,
        'must be an existing property on the object',
      );
    }

    const times = validateTimesOption(optsRecord.times);

    if (isGetter) {
      const origGetter: AnyFn = isAnyFn(resolvedDesc.get)
        ? resolvedDesc.get
        : () => resolvedDesc.value;
      const proxy = this.#createTrackedMock(origGetter, implFn, times);
      this.#recordPropertyRestore(object, methodName, ownDesc);
      Object.defineProperty(object, methodName, {
        get: proxy,
        set: resolvedDesc.set,
        enumerable: resolvedDesc.enumerable ?? true,
        configurable: true,
      });
      return proxy;
    }

    if (isSetter) {
      const origSetter: AnyFn = isAnyFn(resolvedDesc.set) ? resolvedDesc.set : () => undefined;
      const proxy = this.#createTrackedMock(origSetter, implFn, times);
      this.#recordPropertyRestore(object, methodName, ownDesc);
      Object.defineProperty(object, methodName, {
        get: resolvedDesc.get,
        set: proxy,
        enumerable: resolvedDesc.enumerable ?? true,
        configurable: true,
      });
      return proxy;
    }

    if (!isAnyFn(resolvedDesc.value)) {
      throw createInvalidArgType('methodName', 'method', resolvedDesc.value);
    }
    const origMethod = resolvedDesc.value;
    const proxy = this.#createTrackedMock(origMethod, implFn, times);
    this.#recordPropertyRestore(object, methodName, ownDesc);
    Object.defineProperty(object, methodName, {
      value: proxy,
      writable: resolvedDesc.writable ?? true,
      enumerable: resolvedDesc.enumerable ?? false,
      configurable: true,
    });
    return proxy;
  }

  getter(
    object: unknown,
    methodName: PropertyKey,
    implementation?: unknown,
    options?: MockFunctionOptions,
  ): AnyFn & { mock: MockFunctionContext } {
    if (isRecord(implementation) && options === undefined) {
      return this.method(object, methodName, undefined, {
        ...readRawTimesOption(implementation),
        getter: true,
      });
    }
    return this.method(object, methodName, implementation, { ...options, getter: true });
  }

  setter(
    object: unknown,
    methodName: PropertyKey,
    implementation?: unknown,
    options?: MockFunctionOptions,
  ): AnyFn & { mock: MockFunctionContext } {
    if (isRecord(implementation) && options === undefined) {
      return this.method(object, methodName, undefined, {
        ...readRawTimesOption(implementation),
        setter: true,
      });
    }
    return this.method(object, methodName, implementation, { ...options, setter: true });
  }

  restoreAll(): void {
    for (const ctx of this.#contexts) {
      ctx.restore();
    }
    for (let i = this.#propertyRestores.length - 1; i >= 0; i -= 1) {
      const entry = this.#propertyRestores[i];
      if (!entry.hadOwn || entry.descriptor === undefined) {
        Reflect.deleteProperty(entry.target, entry.key);
      } else {
        Object.defineProperty(entry.target, entry.key, entry.descriptor);
      }
    }
    this.#propertyRestores.length = 0;
  }

  reset(): void {
    this.restoreAll();
    for (let i = this.#moduleContexts.length - 1; i >= 0; i -= 1) {
      this.#moduleContexts[i].restore();
    }
    this.#moduleContexts.length = 0;
    this.#timers?.reset();
    this.#contexts.length = 0;
  }

  protected registerModuleContext(ctx: MockModuleContext): MockModuleContext {
    this.#moduleContexts.push(ctx);
    return ctx;
  }

  #createTrackedMock(
    origFn: AnyFn,
    implFn: AnyFn | undefined,
    times: number | undefined,
  ): AnyFn & { mock: MockFunctionContext } {
    const ctx = new MockFunctionContext(origFn, implFn ?? origFn, times);
    this.#contexts.push(ctx);
    return createMockProxy(origFn, ctx);
  }

  #recordPropertyRestore(
    target: object,
    key: PropertyKey,
    ownDesc: PropertyDescriptor | undefined,
  ): void {
    this.#propertyRestores.push({
      target,
      key,
      hadOwn: ownDesc !== undefined,
      descriptor: ownDesc,
    });
  }
}

class ExperimentalModuleMockTracker extends MockTracker {
  module(specifier: unknown, options?: MockModuleOptions): MockModuleContext {
    if (typeof specifier !== 'string') {
      throw createInvalidArgType('specifier', 'string', specifier);
    }
    if (options !== undefined && !isRecord(options)) {
      throw createInvalidArgType('options', 'Object', options);
    }
    const namedExports = options?.namedExports ?? {};
    if (!isRecord(namedExports)) {
      throw createInvalidArgType('options.namedExports', 'Object', namedExports);
    }
    const hasDefault = options !== undefined && 'defaultExport' in options;
    let synthesizedExports: unknown;
    if (hasDefault) {
      const defVal = options.defaultExport;
      if (isRecord(defVal) || typeof defVal === 'function') {
        for (const [k, v] of Object.entries(namedExports)) {
          Reflect.set(defVal, k, v);
        }
        synthesizedExports = defVal;
      } else {
        synthesizedExports = defVal;
      }
    } else {
      synthesizedExports = { ...namedExports };
    }

    const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
    const builtinsTarget = this.builtinsTarget;
    if (builtinsTarget && (specifier.startsWith('node:') || Object.hasOwn(builtinsTarget, bare))) {
      const prevDesc = Object.getOwnPropertyDescriptor(builtinsTarget, bare);
      Object.defineProperty(builtinsTarget, bare, {
        value: synthesizedExports,
        writable: true,
        enumerable: prevDesc?.enumerable ?? true,
        configurable: true,
      });
      this.#syncBuiltinEsmIfAvailable();
      return this.registerModuleContext(
        new MockModuleContext(() => {
          if (prevDesc === undefined) {
            Reflect.deleteProperty(builtinsTarget, bare);
          } else {
            Object.defineProperty(builtinsTarget, bare, prevDesc);
          }
          this.#syncBuiltinEsmIfAvailable();
        }),
      );
    }

    const modBuiltin = this.#tryLoadModuleBuiltin();
    if (modBuiltin && typeof modBuiltin.createRequire === 'function') {
      const baseDir = this.deps.cwd();
      const parentFile = baseDir.endsWith('/')
        ? `${baseDir}__mock__.cjs`
        : `${baseDir}/__mock__.cjs`;
      const req = modBuiltin.createRequire(parentFile);
      if (
        (typeof req === 'function' || isRecord(req)) &&
        'resolve' in req &&
        typeof req.resolve === 'function' &&
        'cache' in req &&
        isRecord(req.cache)
      ) {
        const resolved = String(req.resolve(specifier));
        const cacheObj = req.cache;
        const hadPrev = Object.hasOwn(cacheObj, resolved);
        const prevEntry = cacheObj[resolved];
        cacheObj[resolved] = {
          id: resolved,
          filename: resolved,
          loaded: true,
          exports: synthesizedExports,
        };
        return this.registerModuleContext(
          new MockModuleContext(() => {
            if (hadPrev) {
              cacheObj[resolved] = prevEntry;
            } else {
              Reflect.deleteProperty(cacheObj, resolved);
            }
          }),
        );
      }
    }

    throw createInvalidState(`Cannot mock module '${specifier}' in current loader state`);
  }

  #tryLoadModuleBuiltin(): Record<string, unknown> | undefined {
    try {
      const mod = this.deps.loadModule('node:module');
      return isRecord(mod) ? mod : undefined;
    } catch {
      return undefined;
    }
  }

  #syncBuiltinEsmIfAvailable(): void {
    const mod = this.#tryLoadModuleBuiltin();
    if (mod && typeof mod.syncBuiltinESMExports === 'function') {
      try {
        mod.syncBuiltinESMExports();
      } catch {
        // Ignore if loader ESM cache has not materialized this builtin yet.
      }
    }
  }
}

export function createMockTracker(
  deps: TestRunnerBuiltinsDeps,
  builtinsTarget?: Record<string, unknown>,
): MockTracker {
  if (getProcessExecArgv(deps).includes('--experimental-test-module-mocks')) {
    return new ExperimentalModuleMockTracker(deps, builtinsTarget);
  }
  return new MockTracker(deps, builtinsTarget);
}
