import type { TestRunnerBuiltinsDeps } from '../builtins/test-runner';
import { type MockTracker, createMockTracker } from './mock';
import type { SnapshotManager, SnapshotSerializer } from './snapshot';
import {
  type WaitForOptions,
  createInvalidArgType,
  createInvalidArgValue,
  createTestFailureError,
  isRecord,
} from './types';

export interface ContextBackingNode {
  readonly name: string;
  readonly fullName: string;
  readonly filePath: string | undefined;
  readonly signal: AbortSignal;
  readonly passed: boolean;
  readonly error: Error | null;
  readonly attempt: number;
  readonly deps: TestRunnerBuiltinsDeps;
  readonly builtinsTarget: Record<string, unknown> | undefined;
  readonly assertRegistry: AssertRegistry;
  readonly snapshotManager: SnapshotManager;
  addDiagnostic(message: string): void;
  setPlan(count: number, waitOption?: boolean | number): void;
  recordAssertion(): void;
  setRunOnly(value: boolean): void;
  markSkip(message?: string): void;
  markTodo(message?: string): void;
  createSubtest(name?: unknown, options?: unknown, fn?: unknown): Promise<void>;
  registerHook(
    kind: 'before' | 'after' | 'beforeEach' | 'afterEach',
    fn?: unknown,
    options?: unknown,
  ): void;
}

export class AssertRegistry {
  readonly #deps: TestRunnerBuiltinsDeps;
  readonly #custom = new Map<string, (this: TestContext, ...args: unknown[]) => unknown>();

  constructor(deps: TestRunnerBuiltinsDeps) {
    this.#deps = deps;
  }

  register(name: unknown, fn: unknown): void {
    if (typeof name !== 'string') {
      throw createInvalidArgType('name', 'string', name);
    }
    if (typeof fn !== 'function') {
      throw createInvalidArgType('fn', 'Function', fn);
    }
    // Invariant: narrowed fn to a callable function above.
    this.#custom.set(name, fn as (this: TestContext, ...args: unknown[]) => unknown);
  }

  createNamespace(): Record<string, unknown> {
    const registerCall = (name: unknown, fn: unknown): void => {
      this.register(name, fn);
    };
    function register(name: unknown, fn: unknown): void {
      registerCall(name, fn);
    }
    const ns: Record<string, unknown> = Object.create(null);
    Object.defineProperty(ns, 'register', {
      value: register,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return ns;
  }

  createContextAssert(ctx: TestContext, node: ContextBackingNode): Record<string, unknown> {
    const rawAssert = this.#deps.loadModule('node:assert/strict');
    const assertObj: Record<string, unknown> = {};

    const wrapFn = (
      fn: (...args: unknown[]) => unknown,
      receiverMode: 'assert' | 'context',
    ): ((...args: unknown[]) => unknown) => {
      return (...args: unknown[]): unknown => {
        node.recordAssertion();
        return fn.apply(receiverMode === 'context' ? ctx : assertObj, args);
      };
    };

    if (typeof rawAssert === 'function' || isRecord(rawAssert)) {
      for (const key of Reflect.ownKeys(rawAssert)) {
        if (key === 'length' || key === 'name' || key === 'prototype') continue;
        const val = Reflect.get(rawAssert, key);
        if (typeof key === 'string') {
          if (typeof val === 'function') {
            // Invariant: narrowed val to a callable function above.
            assertObj[key] = wrapFn(val as (...args: unknown[]) => unknown, 'assert');
          } else {
            assertObj[key] = val;
          }
        }
      }
    }

    assertObj.snapshot = (
      value: unknown,
      options?: { serializers?: ReadonlyArray<SnapshotSerializer> },
    ): void => {
      node.recordAssertion();
      node.snapshotManager.assertSnapshot(
        { fullName: ctx.fullName, filePath: ctx.filePath },
        value,
        options,
      );
    };

    assertObj.fileSnapshot = (
      value: unknown,
      snapshotPath: string,
      options?: { serializers?: ReadonlyArray<SnapshotSerializer> },
    ): void => {
      node.recordAssertion();
      node.snapshotManager.assertFileSnapshot(value, snapshotPath, options);
    };

    for (const [customName, customFn] of this.#custom.entries()) {
      assertObj[customName] = (...args: unknown[]): unknown => {
        node.recordAssertion();
        return customFn.apply(ctx, args);
      };
    }

    return assertObj;
  }
}

export class SuiteContext {
  readonly #node: ContextBackingNode;

  constructor(node: ContextBackingNode) {
    this.#node = node;
  }

  get signal(): AbortSignal {
    return this.#node.signal;
  }

  get name(): string {
    return this.#node.name;
  }

  get fullName(): string {
    return this.#node.fullName;
  }

  get filePath(): string | undefined {
    return this.#node.filePath;
  }
}

export class TestContext {
  readonly #node: ContextBackingNode;
  #assert: Record<string, unknown> | undefined;
  #mock: MockTracker | undefined;

  constructor(node: ContextBackingNode) {
    this.#node = node;
  }

  get signal(): AbortSignal {
    return this.#node.signal;
  }

  get name(): string {
    return this.#node.name;
  }

  get fullName(): string {
    return this.#node.fullName;
  }

  get filePath(): string | undefined {
    return this.#node.filePath;
  }

  get error(): Error | null {
    return this.#node.error;
  }

  get passed(): boolean {
    return this.#node.passed;
  }

  get attempt(): number {
    return this.#node.attempt;
  }

  diagnostic(message: string): void {
    this.#node.addDiagnostic(String(message));
  }

  plan(count: number, options?: { wait?: boolean | number }): void {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      throw createInvalidArgValue('count', count, 'must be a non-negative integer');
    }
    let waitOption: boolean | number | undefined;
    if (options !== undefined) {
      if (!isRecord(options)) {
        throw createInvalidArgType('options', 'Object', options);
      }
      const rawWait = options.wait;
      if (
        rawWait !== undefined &&
        typeof rawWait !== 'boolean' &&
        (typeof rawWait !== 'number' || Number.isNaN(rawWait) || rawWait < 0)
      ) {
        throw createInvalidArgType('options.wait', 'boolean or number', rawWait);
      }
      waitOption = rawWait;
    }
    this.#node.setPlan(count, waitOption);
  }

  get assert(): Record<string, unknown> {
    this.#assert ??= this.#node.assertRegistry.createContextAssert(this, this.#node);
    return this.#assert;
  }

  get mock(): MockTracker {
    this.#mock ??= createMockTracker(this.#node.deps, this.#node.builtinsTarget);
    return this.#mock;
  }

  resetOwnMocks(): void {
    this.#mock?.reset();
  }

  runOnly(value = true): void {
    if (typeof value !== 'boolean') {
      throw createInvalidArgType('value', 'boolean', value);
    }
    this.#node.setRunOnly(value);
  }

  skip(message?: string): void {
    this.#node.markSkip(message === undefined ? undefined : String(message));
  }

  todo(message?: string): void {
    this.#node.markTodo(message === undefined ? undefined : String(message));
  }

  test(name?: unknown, options?: unknown, fn?: unknown): Promise<void> {
    return this.#node.createSubtest(name, options, fn);
  }

  before(fn?: unknown, options?: unknown): void {
    this.#node.registerHook('before', fn, options);
  }

  after(fn?: unknown, options?: unknown): void {
    this.#node.registerHook('after', fn, options);
  }

  beforeEach(fn?: unknown, options?: unknown): void {
    this.#node.registerHook('beforeEach', fn, options);
  }

  afterEach(fn?: unknown, options?: unknown): void {
    this.#node.registerHook('afterEach', fn, options);
  }

  async waitFor(condition: () => unknown, options?: WaitForOptions): Promise<unknown> {
    if (typeof condition !== 'function') {
      throw createInvalidArgType('condition', 'Function', condition);
    }
    let interval = 50;
    let timeout = 1000;
    if (options !== undefined) {
      if (!isRecord(options)) {
        throw createInvalidArgType('options', 'Object', options);
      }
      if (options.interval !== undefined) {
        if (typeof options.interval !== 'number' || options.interval < 0) {
          throw createInvalidArgType('options.interval', 'number', options.interval);
        }
        interval = options.interval;
      }
      if (options.timeout !== undefined) {
        if (typeof options.timeout !== 'number' || options.timeout < 0) {
          throw createInvalidArgType('options.timeout', 'number', options.timeout);
        }
        timeout = options.timeout;
      }
    }

    const startNs = this.#node.deps.hrtimeNs();
    const timeoutNs = BigInt(Math.round(timeout * 1_000_000));
    let lastError: unknown;

    for (;;) {
      if (this.#node.signal.aborted) {
        throw createTestFailureError(
          this.#node.signal.reason ?? new Error('Test aborted'),
          'cancelledByParent',
        );
      }
      try {
        return await condition();
      } catch (err) {
        lastError = err;
      }
      const elapsedNs = this.#node.deps.hrtimeNs() - startNs;
      if (elapsedNs >= timeoutNs) {
        const timeoutErr = new Error(`waitFor() timed out after ${timeout}ms`);
        if (lastError !== undefined) {
          Object.assign(timeoutErr, { cause: lastError });
        }
        throw createTestFailureError(timeoutErr, 'testTimeoutFailure');
      }
      await new Promise<void>((resolve) => {
        this.#node.deps.setTimeout(() => resolve(), interval);
      });
    }
  }
}
