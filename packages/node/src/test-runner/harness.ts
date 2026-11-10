import type { TestRunnerBuiltinsDeps } from '../builtins/test-runner';
import { AssertRegistry, type ContextBackingNode, SuiteContext, TestContext } from './context';
import { type MockTracker, createMockTracker } from './mock';
import { createDefaultStdoutSink } from './reporters';
import { createRunFunction } from './run';
import { SnapshotManager } from './snapshot';
import {
  type EventSink,
  type HookOptions,
  type SourceLocation,
  type TestOptions,
  type TestSummaryCounts,
  type TestsStreamEvent,
  createInvalidArgType,
  createTestFailureError,
  extractCallerLocation,
  formatSummaryDiagnosticMessages,
  getProcessExecArgv,
  isPromiseLike,
  isRecord,
  setProcessExitCode,
} from './types';

type HookKind = 'before' | 'after' | 'beforeEach' | 'afterEach';
type UserFn = (ctx: unknown, done?: (err?: unknown) => void) => unknown;

interface HookEntry {
  fn: UserFn;
  options: HookOptions;
}

interface ParsedTestCall {
  name: string;
  options: TestOptions;
  fn: UserFn | undefined;
}

interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
}

function tryCreateAsyncContextStore<T>(
  deps: TestRunnerBuiltinsDeps,
): AsyncLocalStorageLike<T | undefined> | undefined {
  const ctor = deps.asyncHooks.AsyncLocalStorage;
  if (typeof ctor !== 'function') return undefined;
  try {
    // Invariant: narrowed ctor to a constructor function above.
    const instance = Reflect.construct(ctor as new () => AsyncLocalStorageLike<T | undefined>, []);
    let supported = false;
    instance.run(undefined, () => {
      supported = true;
    });
    return supported ? instance : undefined;
  } catch {
    return undefined;
  }
}

function parseTestCall(nameArg: unknown, optionsArg: unknown, fnArg: unknown): ParsedTestCall {
  let name: string;
  let rawOptions: unknown;
  let fn: unknown;

  if (typeof nameArg === 'function') {
    name = nameArg.name || '<anonymous>';
    rawOptions = {};
    fn = nameArg;
  } else if (nameArg !== undefined && typeof nameArg === 'object' && nameArg !== null) {
    rawOptions = nameArg;
    fn = optionsArg;
    name = typeof fn === 'function' && fn.name ? fn.name : '<anonymous>';
  } else if (typeof nameArg === 'string') {
    name = nameArg;
    if (typeof optionsArg === 'function') {
      rawOptions = {};
      fn = optionsArg;
    } else {
      rawOptions = optionsArg ?? {};
      fn = fnArg;
    }
  } else if (nameArg === undefined) {
    if (typeof optionsArg === 'function') {
      rawOptions = {};
      fn = optionsArg;
    } else if (isRecord(optionsArg)) {
      rawOptions = optionsArg;
      fn = fnArg;
    } else {
      rawOptions = {};
      fn = fnArg;
    }
    name = typeof fn === 'function' && fn.name ? fn.name : '<anonymous>';
  } else {
    throw createInvalidArgType('name', 'string, Object, or Function', nameArg);
  }

  if (rawOptions !== undefined && !isRecord(rawOptions)) {
    throw createInvalidArgType('options', 'Object', rawOptions);
  }
  if (fn !== undefined && typeof fn !== 'function') {
    throw createInvalidArgType('fn', 'Function', fn);
  }

  const optsRecord = isRecord(rawOptions) ? rawOptions : {};
  const options: TestOptions = {};
  if (optsRecord.concurrency !== undefined) {
    if (typeof optsRecord.concurrency !== 'boolean' && typeof optsRecord.concurrency !== 'number') {
      throw createInvalidArgType(
        'options.concurrency',
        'boolean or number',
        optsRecord.concurrency,
      );
    }
    options.concurrency = optsRecord.concurrency;
  }
  if (optsRecord.only !== undefined) {
    options.only = Boolean(optsRecord.only);
  }
  if (optsRecord.signal !== undefined) {
    if (!(optsRecord.signal instanceof AbortSignal)) {
      throw createInvalidArgType('options.signal', 'AbortSignal', optsRecord.signal);
    }
    options.signal = optsRecord.signal;
  }
  if (optsRecord.skip !== undefined) {
    options.skip = typeof optsRecord.skip === 'string' ? optsRecord.skip : Boolean(optsRecord.skip);
  }
  if (optsRecord.todo !== undefined) {
    options.todo = typeof optsRecord.todo === 'string' ? optsRecord.todo : Boolean(optsRecord.todo);
  }
  if (optsRecord.timeout !== undefined) {
    if (typeof optsRecord.timeout !== 'number' || optsRecord.timeout < 0) {
      throw createInvalidArgType('options.timeout', 'number', optsRecord.timeout);
    }
    options.timeout = optsRecord.timeout;
  }
  if (optsRecord.plan !== undefined) {
    if (
      typeof optsRecord.plan !== 'number' ||
      !Number.isInteger(optsRecord.plan) ||
      optsRecord.plan < 0
    ) {
      throw createInvalidArgType('options.plan', 'non-negative integer', optsRecord.plan);
    }
    options.plan = optsRecord.plan;
  }

  return {
    name,
    options,
    // Invariant: narrowed fn to undefined or a callable function above.
    fn: fn as UserFn | undefined,
  };
}

function parseHookCall(fnArg: unknown, optionsArg: unknown): HookEntry | undefined {
  if (fnArg === undefined) return undefined;
  if (typeof fnArg !== 'function') {
    throw createInvalidArgType('fn', 'Function', fnArg);
  }
  const options: HookOptions = {};
  if (optionsArg !== undefined) {
    if (!isRecord(optionsArg)) {
      throw createInvalidArgType('options', 'Object', optionsArg);
    }
    if (optionsArg.signal !== undefined) {
      if (!(optionsArg.signal instanceof AbortSignal)) {
        throw createInvalidArgType('options.signal', 'AbortSignal', optionsArg.signal);
      }
      options.signal = optionsArg.signal;
    }
    if (optionsArg.timeout !== undefined) {
      if (typeof optionsArg.timeout !== 'number' || optionsArg.timeout < 0) {
        throw createInvalidArgType('options.timeout', 'number', optionsArg.timeout);
      }
      options.timeout = optionsArg.timeout;
    }
  }
  // Invariant: narrowed fnArg to a callable function above.
  return { fn: fnArg as UserFn, options };
}

function resolveConcurrency(value: number | boolean | undefined): number {
  if (typeof value === 'number' && value >= 1) {
    return Math.floor(value);
  }
  if (value === true) {
    return 4;
  }
  return 1;
}

async function runWithConcurrency<T>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  if (limit <= 1) {
    for (const item of items) {
      await worker(item);
    }
    return;
  }
  let nextIdx = 0;
  const laneCount = Math.min(limit, items.length);
  const lanes: Array<Promise<void>> = [];
  for (let i = 0; i < laneCount; i += 1) {
    lanes.push(
      (async () => {
        while (nextIdx < items.length) {
          const idx = nextIdx;
          nextIdx += 1;
          await worker(items[idx]);
        }
      })(),
    );
  }
  await Promise.all(lanes);
}

export interface FileHarnessContext {
  filePath: string;
  onlyMode?: boolean;
  timeout?: number;
  signal?: AbortSignal;
  testNamePatterns?: ReadonlyArray<RegExp>;
  testSkipPatterns?: ReadonlyArray<RegExp>;
  updateSnapshots?: boolean;
  sink: EventSink;
}

class TestNode implements ContextBackingNode {
  readonly harness: HarnessInstance;
  readonly parent: TestNode | undefined;
  readonly kind: 'root' | 'suite' | 'test';
  readonly name: string;
  readonly fullName: string;
  readonly location: SourceLocation;
  readonly options: TestOptions;
  readonly fn: UserFn | undefined;
  readonly nesting: number;

  readonly children: TestNode[] = [];
  readonly hooks: Record<HookKind, HookEntry[]> = {
    before: [],
    after: [],
    beforeEach: [],
    afterEach: [],
  };
  readonly bufferedDiagnostics: string[] = [];

  readonly #abortController = new AbortController();
  readonly #completionPromise: Promise<void>;
  #resolveCompletion!: () => void;

  #testContext: TestContext | undefined;
  #suiteContext: SuiteContext | undefined;
  #suiteDiscoveryError: unknown;
  #suiteDiscoveryPromise: Promise<unknown> | undefined;

  #started = false;
  #finished = false;
  #passed = false;
  #error: Error | null = null;
  #attempt = 0;
  #skip: boolean | string | undefined;
  #todo: boolean | string | undefined;
  #runOnlyChildren: boolean;
  #plannedCount: number | undefined;
  #planWait: boolean | number | undefined;
  #assertionCount = 0;
  #planWaitResolver: (() => void) | undefined;
  #subtestCounter = 0;
  #subtestRunnerActive = false;
  readonly #activeBeforeHookPromises: Array<Promise<void>> = [];
  #hasBeforeHookFailure = false;
  #beforeHookRawFailure: unknown = undefined;
  readonly #dynamicChildPromises: Array<Promise<void>> = [];
  #dynamicChildFailedCount = 0;

  constructor(params: {
    harness: HarnessInstance;
    parent: TestNode | undefined;
    kind: 'root' | 'suite' | 'test';
    name: string;
    location: SourceLocation;
    options: TestOptions;
    fn: UserFn | undefined;
  }) {
    this.harness = params.harness;
    this.parent = params.parent;
    this.kind = params.kind;
    this.name = params.name;
    this.location = params.location;
    this.options = params.options;
    this.fn = params.fn;
    this.nesting = params.parent
      ? params.parent.kind === 'root'
        ? 0
        : params.parent.nesting + 1
      : -1;
    this.fullName =
      params.parent && params.parent.kind !== 'root'
        ? `${params.parent.fullName} > ${params.name}`
        : params.name;

    this.#skip = params.options.skip;
    this.#todo = params.options.todo;
    if (params.kind === 'test' && params.fn === undefined && !this.#skip && !this.#todo) {
      this.#todo = true;
    }
    if (params.options.plan !== undefined) {
      this.#plannedCount = params.options.plan;
    }
    this.#runOnlyChildren = params.harness.defaultOnlyMode;

    if (params.parent) {
      const parentSignal = params.parent.signal;
      if (parentSignal.aborted) {
        this.#abortController.abort(parentSignal.reason);
      } else {
        parentSignal.addEventListener(
          'abort',
          () => this.#abortController.abort(parentSignal.reason),
          { once: true },
        );
      }
    }
    if (params.options.signal) {
      const extSignal = params.options.signal;
      if (extSignal.aborted) {
        this.#abortController.abort(extSignal.reason);
      } else {
        extSignal.addEventListener('abort', () => this.#abortController.abort(extSignal.reason), {
          once: true,
        });
      }
    }

    this.#completionPromise = new Promise<void>((resolve) => {
      this.#resolveCompletion = resolve;
    });
  }

  get deps(): TestRunnerBuiltinsDeps {
    return this.harness.deps;
  }

  get builtinsTarget(): Record<string, unknown> | undefined {
    return this.harness.builtinsTarget;
  }

  get assertRegistry(): AssertRegistry {
    return this.harness.assertRegistry;
  }

  get snapshotManager(): SnapshotManager {
    return this.harness.snapshotManager;
  }

  get filePath(): string | undefined {
    return this.location.file ?? this.harness.defaultFilePath;
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  get passed(): boolean {
    return this.#passed;
  }

  get error(): Error | null {
    return this.#error;
  }

  get attempt(): number {
    return this.#attempt;
  }

  get skipReason(): boolean | string | undefined {
    return this.#skip;
  }

  get todoReason(): boolean | string | undefined {
    return this.#todo;
  }

  get completion(): Promise<void> {
    return this.#completionPromise;
  }

  get testContext(): TestContext {
    this.#testContext ??= new TestContext(this);
    return this.#testContext;
  }

  get suiteContext(): SuiteContext {
    this.#suiteContext ??= new SuiteContext(this);
    return this.#suiteContext;
  }

  addDiagnostic(message: string): void {
    if (this.#started && !this.#finished) {
      this.harness.emit({
        type: 'test:diagnostic',
        data: {
          nesting: this.kind === 'root' ? 0 : this.nesting + (this.children.length > 0 ? 1 : 0),
          message,
          level: 'info',
          ...this.locationFields(),
        },
      });
    } else {
      this.bufferedDiagnostics.push(message);
    }
  }

  setPlan(count: number, waitOption?: boolean | number): void {
    this.#plannedCount = count;
    this.#planWait = waitOption;
    if (this.#assertionCount >= count && this.#planWaitResolver) {
      const resolve = this.#planWaitResolver;
      this.#planWaitResolver = undefined;
      resolve();
    }
  }

  recordAssertion(): void {
    this.#assertionCount += 1;
    if (
      this.#plannedCount !== undefined &&
      this.#assertionCount >= this.#plannedCount &&
      this.#planWaitResolver
    ) {
      const resolve = this.#planWaitResolver;
      this.#planWaitResolver = undefined;
      resolve();
    }
  }

  setRunOnly(value: boolean): void {
    this.#runOnlyChildren = value;
  }

  markSkip(message?: string): void {
    this.#skip = message !== undefined && message.length > 0 ? message : true;
  }

  markTodo(message?: string): void {
    this.#todo = message !== undefined && message.length > 0 ? message : true;
  }

  createSubtest(name?: unknown, options?: unknown, fn?: unknown): Promise<void> {
    return this.harness.registerChild(this, 'test', name, options, fn);
  }

  registerHook(kind: HookKind, fn?: unknown, options?: unknown): void {
    const parsed = parseHookCall(fn, options);
    if (!parsed) return;
    if (kind === 'before' && this.kind === 'test' && this.#started && !this.#finished) {
      this.startTestBeforeHookOnce(parsed);
      return;
    }
    this.hooks[kind].push(parsed);
  }

  private startTestBeforeHookOnce(hook: HookEntry): void {
    const pending = this.invokeCallable(
      hook.fn,
      this.testContext,
      hook.options,
      'hookFailed',
    ).catch((err: unknown) => {
      if (!this.#hasBeforeHookFailure) {
        this.#hasBeforeHookFailure = true;
        this.#beforeHookRawFailure =
          err instanceof Error && 'cause' in err && err.cause !== undefined ? err.cause : err;
      }
    });
    this.#activeBeforeHookPromises.push(pending);
  }

  async settleActiveBeforeHooksForChild(): Promise<void> {
    while (this.#activeBeforeHookPromises.length > 0) {
      const batch = [...this.#activeBeforeHookPromises];
      this.#activeBeforeHookPromises.length = 0;
      await Promise.all(batch);
    }
    if (this.#hasBeforeHookFailure) {
      throw createTestFailureError(this.#beforeHookRawFailure, 'hookFailed');
    }
  }

  discoverSuiteSynchronously(): void {
    if (this.kind !== 'suite' || !this.fn || this.#skip) return;
    try {
      const result = this.harness.runInNodeScope(this, () => this.fn?.(this.suiteContext));
      if (isPromiseLike(result)) {
        this.#suiteDiscoveryPromise = Promise.resolve(result);
      }
    } catch (err) {
      this.#suiteDiscoveryError = err;
    }
  }

  locationFields(): SourceLocation {
    const out: SourceLocation = {};
    if (this.location.line !== undefined) out.line = this.location.line;
    if (this.location.column !== undefined) out.column = this.location.column;
    const file = this.filePath;
    if (file !== undefined) out.file = file;
    return out;
  }

  matchesFilterPatterns(): boolean {
    const namePatterns = this.harness.testNamePatterns;
    const skipPatterns = this.harness.testSkipPatterns;
    if (skipPatterns && skipPatterns.length > 0) {
      if (skipPatterns.some((re) => re.test(this.name) || re.test(this.fullName))) {
        return false;
      }
    }
    if (namePatterns && namePatterns.length > 0) {
      if (this.kind === 'suite' && this.children.some((child) => child.matchesFilterPatterns())) {
        return true;
      }
      const selfMatches = namePatterns.some((re) => re.test(this.name) || re.test(this.fullName));
      if (selfMatches) return true;
      let ancestor = this.parent;
      while (ancestor && ancestor.kind !== 'root') {
        const currentAncestor = ancestor;
        if (
          namePatterns.some(
            (re) => re.test(currentAncestor.name) || re.test(currentAncestor.fullName),
          )
        ) {
          return true;
        }
        ancestor = ancestor.parent;
      }
      return false;
    }
    return true;
  }

  async execute(testNumber: number): Promise<{ failedNonTodo: boolean }> {
    this.#started = true;
    const startNs = this.deps.hrtimeNs();
    const loc = this.locationFields();

    this.harness.emit({
      type: 'test:dequeue',
      data: {
        nesting: this.nesting,
        name: this.name,
        type: this.kind === 'suite' ? 'suite' : 'test',
        ...loc,
      },
    });

    const parentHasOnly = Boolean(
      this.parent &&
        (this.parent.#runOnlyChildren ||
          (this.harness.defaultOnlyMode && this.parent.children.some((c) => c.options.only))),
    );
    if (parentHasOnly && !this.options.only && !this.#skip) {
      this.#skip = "'only' option not set";
    }
    if (!this.#skip && !this.matchesFilterPatterns()) {
      this.#skip = 'test name does not match pattern';
    }

    this.harness.emit({
      type: 'test:start',
      data: {
        nesting: this.nesting,
        name: this.name,
        ...loc,
      },
    });

    if (this.#skip !== undefined && this.#skip !== false) {
      const durationMs = Number(this.deps.hrtimeNs() - startNs) / 1_000_000;
      this.#passed = true;
      this.#finished = true;
      this.harness.recordCount(this.kind, 'skipped');
      this.emitOutcome('test:pass', testNumber, durationMs);
      this.#resolveCompletion();
      return { failedNonTodo: false };
    }

    const ancestralBeforeEach = this.collectAncestralHooks('beforeEach');
    const ancestralAfterEach = this.collectAncestralHooks('afterEach');
    let failureError: Error | null = null;

    try {
      if (this.kind === 'suite') {
        if (this.#suiteDiscoveryError !== undefined) {
          throw createTestFailureError(this.#suiteDiscoveryError, 'testCodeFailure');
        }
        if (this.#suiteDiscoveryPromise) {
          await this.runPromiseWithTimeout(this.#suiteDiscoveryPromise, this.effectiveTimeout());
        }
        for (const hook of this.hooks.before) {
          await this.invokeCallable(hook.fn, this.testContext, hook.options, 'hookFailed');
        }
        const subFailed = await this.drainChildren();
        if (subFailed) {
          failureError = createTestFailureError(
            new Error(`${subFailed} subtest(s) failed`),
            'subtestsFailed',
          );
        }
      } else {
        if (this.parent && this.parent.kind === 'test') {
          await this.parent.settleActiveBeforeHooksForChild();
        }
        for (const hook of ancestralBeforeEach) {
          await this.invokeCallable(hook.fn, this.testContext, hook.options, 'hookFailed');
        }
        for (const preHook of this.hooks.before) {
          this.startTestBeforeHookOnce(preHook);
        }
        if (this.fn) {
          await this.invokeCallable(
            this.fn,
            this.testContext,
            { timeout: this.effectiveTimeout(), signal: this.options.signal },
            'testCodeFailure',
          );
        }
        await this.waitForPlannedAssertions();
        const queuedSubFailed = await this.drainChildren();
        if (this.#dynamicChildPromises.length > 0) {
          await Promise.all(this.#dynamicChildPromises);
        }
        const totalSubFailed = queuedSubFailed + this.#dynamicChildFailedCount;
        if (this.#plannedCount !== undefined && this.#assertionCount !== this.#plannedCount) {
          throw createTestFailureError(
            new Error(
              `plan expected ${this.#plannedCount} assertions but received ${this.#assertionCount}`,
            ),
            'testCodeFailure',
          );
        }
        if (totalSubFailed > 0) {
          failureError = this.#hasBeforeHookFailure
            ? createTestFailureError(this.#beforeHookRawFailure, 'testCodeFailure')
            : createTestFailureError(
                new Error(`${totalSubFailed} subtest(s) failed`),
                'subtestsFailed',
              );
        }
      }
    } catch (err) {
      failureError = createTestFailureError(
        err,
        this.signal.aborted ? 'cancelledByParent' : 'testCodeFailure',
      );
    } finally {
      if (failureError === null) {
        this.#passed = true;
        this.#error = null;
      } else {
        this.#passed = false;
        this.#error = failureError;
      }

      if (this.kind === 'test') {
        for (const hook of ancestralAfterEach) {
          try {
            await this.invokeCallable(hook.fn, this.testContext, hook.options, 'hookFailed', true);
          } catch (hookErr) {
            if (failureError === null) {
              failureError = createTestFailureError(hookErr, 'hookFailed');
              this.#passed = false;
              this.#error = failureError;
            }
          }
        }
      } else if (this.kind === 'suite') {
        for (const hook of this.hooks.after) {
          try {
            await this.invokeCallable(hook.fn, this.testContext, hook.options, 'hookFailed', true);
          } catch (hookErr) {
            if (failureError === null) {
              failureError = createTestFailureError(hookErr, 'hookFailed');
              this.#passed = false;
              this.#error = failureError;
            }
          }
        }
      }

      for (const hook of this.kind === 'test' ? this.hooks.after : []) {
        try {
          await this.invokeCallable(hook.fn, this.testContext, hook.options, 'hookFailed', true);
        } catch (hookErr) {
          if (failureError === null) {
            failureError = createTestFailureError(hookErr, 'hookFailed');
            this.#passed = false;
            this.#error = failureError;
          }
        }
      }

      this.#testContext?.resetOwnMocks();
    }

    if (this.children.length > 0) {
      this.harness.emit({
        type: 'test:plan',
        data: {
          nesting: this.nesting + 1,
          count: this.#subtestCounter,
          ...loc,
        },
      });
    }

    for (const msg of this.bufferedDiagnostics) {
      this.harness.emit({
        type: 'test:diagnostic',
        data: {
          nesting: this.nesting + 1,
          message: msg,
          level: 'info',
          ...loc,
        },
      });
    }
    this.bufferedDiagnostics.length = 0;

    const durationMs = Number(this.deps.hrtimeNs() - startNs) / 1_000_000;
    this.#finished = true;

    const isTodo = this.#todo !== undefined && this.#todo !== false;
    if (isTodo) {
      this.harness.recordCount(this.kind, 'todo');
    } else if (failureError !== null) {
      const ft =
        'failureType' in failureError && failureError.failureType === 'cancelledByParent'
          ? 'cancelled'
          : 'fail';
      this.harness.recordCount(this.kind, ft);
    } else {
      this.harness.recordCount(this.kind, 'pass');
    }

    this.emitOutcome(failureError === null ? 'test:pass' : 'test:fail', testNumber, durationMs);
    this.#resolveCompletion();

    return { failedNonTodo: failureError !== null && !isTodo };
  }

  private emitOutcome(
    eventType: 'test:pass' | 'test:fail',
    testNumber: number,
    durationMs: number,
  ): void {
    const loc = this.locationFields();
    const nodeType: 'test' | 'suite' = this.kind === 'suite' ? 'suite' : 'test';
    const skipField = this.#skip !== undefined && this.#skip !== false ? { skip: this.#skip } : {};
    const todoField = this.#todo !== undefined && this.#todo !== false ? { todo: this.#todo } : {};

    this.harness.emit({
      type: 'test:complete',
      data: {
        name: this.name,
        nesting: this.nesting,
        testNumber,
        details: {
          duration_ms: durationMs,
          type: nodeType,
          passed: eventType === 'test:pass',
          ...(this.#error ? { error: this.#error } : {}),
        },
        ...loc,
        ...skipField,
        ...todoField,
      },
    });

    this.harness.emit({
      type: eventType,
      data: {
        name: this.name,
        nesting: this.nesting,
        testNumber,
        details: {
          duration_ms: durationMs,
          type: nodeType,
          ...(this.#error ? { error: this.#error } : {}),
        },
        ...loc,
        ...skipField,
        ...todoField,
      },
    });
  }

  private effectiveTimeout(): number | undefined {
    if (this.options.timeout !== undefined) return this.options.timeout;
    let cur = this.parent;
    while (cur) {
      if (cur.options.timeout !== undefined) return cur.options.timeout;
      cur = cur.parent;
    }
    return this.harness.defaultTimeout;
  }

  private collectAncestralHooks(kind: 'beforeEach' | 'afterEach'): HookEntry[] {
    const chain: TestNode[] = [];
    let cur = this.parent;
    while (cur) {
      chain.push(cur);
      cur = cur.parent;
    }
    if (kind === 'beforeEach') {
      chain.reverse();
    }
    const entries: HookEntry[] = [];
    for (const ancestor of chain) {
      entries.push(...ancestor.hooks[kind]);
    }
    return entries;
  }

  private async waitForPlannedAssertions(): Promise<void> {
    if (
      this.#plannedCount === undefined ||
      !this.#planWait ||
      this.#assertionCount >= this.#plannedCount
    ) {
      return;
    }
    const waitMs =
      typeof this.#planWait === 'number' ? this.#planWait : (this.effectiveTimeout() ?? 1000);
    await new Promise<void>((resolve, reject) => {
      const timer = this.deps.setTimeout(() => {
        this.#planWaitResolver = undefined;
        reject(
          createTestFailureError(
            new Error(
              `plan timed out waiting for ${this.#plannedCount} assertions (received ${this.#assertionCount})`,
            ),
            'testTimeoutFailure',
          ),
        );
      }, waitMs);
      this.#planWaitResolver = () => {
        this.deps.clearTimeout(timer);
        resolve();
      };
    });
  }

  async drainChildren(): Promise<number> {
    if (this.#subtestRunnerActive) return 0;
    this.#subtestRunnerActive = true;
    let failedCount = 0;
    try {
      while (this.#subtestCounter < this.children.length) {
        const batch = this.children.slice(this.#subtestCounter);
        const startOffset = this.#subtestCounter;
        this.#subtestCounter += batch.length;
        const limit = resolveConcurrency(this.options.concurrency);
        let idxOffset = 0;
        await runWithConcurrency(batch, limit, async (child) => {
          idxOffset += 1;
          const num = startOffset + idxOffset;
          const res = await child.execute(num);
          if (res.failedNonTodo) {
            failedCount += 1;
          }
        });
      }
    } finally {
      this.#subtestRunnerActive = false;
    }
    return failedCount;
  }

  startDynamicChildIfRunning(child: TestNode): void {
    if (this.kind === 'test' && this.#started && !this.#finished && !this.#subtestRunnerActive) {
      this.#subtestCounter += 1;
      const num = this.#subtestCounter;
      const pending = child.execute(num).then((res) => {
        if (res.failedNonTodo) {
          this.#dynamicChildFailedCount += 1;
          if (this.#error === null) {
            this.#error = this.#hasBeforeHookFailure
              ? createTestFailureError(this.#beforeHookRawFailure, 'testCodeFailure')
              : createTestFailureError(new Error('1 subtest(s) failed'), 'subtestsFailed');
          }
        }
      });
      this.#dynamicChildPromises.push(pending);
    }
  }

  private async invokeCallable(
    fn: UserFn,
    ctx: TestContext,
    options: HookOptions,
    defaultFailureType: 'testCodeFailure' | 'hookFailed',
    isCleanupHook = false,
  ): Promise<void> {
    if (!isCleanupHook && this.signal.aborted) {
      throw createTestFailureError(
        this.signal.reason ?? new Error('Test cancelled'),
        'cancelledByParent',
      );
    }
    if (options.signal?.aborted) {
      throw createTestFailureError(
        options.signal.reason ?? new Error('Hook cancelled'),
        'cancelledByParent',
      );
    }

    const runPromise = new Promise<void>((resolve, reject) => {
      if (fn.length >= 2) {
        let settled = false;
        const done = (err?: unknown): void => {
          if (settled) return;
          settled = true;
          if (err !== undefined && err !== null) {
            reject(err);
          } else {
            resolve();
          }
        };
        try {
          const ret = this.harness.runInNodeScope(this, () => fn(ctx, done));
          if (isPromiseLike(ret)) {
            Promise.resolve(ret).then(
              () => {
                // In callback mode, wait for done() unless promise rejects.
              },
              (err) => {
                if (!settled) {
                  settled = true;
                  reject(err);
                }
              },
            );
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            reject(err);
          }
        }
        return;
      }

      try {
        const ret = this.harness.runInNodeScope(this, () => fn(ctx));
        if (isPromiseLike(ret)) {
          Promise.resolve(ret).then(() => resolve(), reject);
        } else {
          resolve();
        }
      } catch (err) {
        reject(err);
      }
    });

    try {
      await this.runPromiseWithTimeout(runPromise, options.timeout ?? this.effectiveTimeout());
    } catch (err) {
      if (err && isRecord(err) && err.code === 'ERR_TEST_FAILURE') {
        throw err;
      }
      throw createTestFailureError(err, defaultFailureType);
    }
  }

  private async runPromiseWithTimeout(
    promise: Promise<unknown>,
    timeoutMs: number | undefined,
  ): Promise<void> {
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
      await promise;
      return;
    }
    let timer: unknown;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = this.deps.setTimeout(() => {
        const timeoutErr = new Error(`Test timed out after ${timeoutMs}ms`);
        this.#abortController.abort(timeoutErr);
        reject(createTestFailureError(timeoutErr, 'testTimeoutFailure'));
      }, timeoutMs);
    });
    try {
      await Promise.race([promise, timeoutPromise]);
    } finally {
      this.deps.clearTimeout(timer);
    }
  }
}

export class HarnessInstance {
  readonly deps: TestRunnerBuiltinsDeps;
  readonly builtinsTarget: Record<string, unknown> | undefined;
  readonly assertRegistry: AssertRegistry;
  readonly snapshotManager: SnapshotManager;
  readonly mock: MockTracker;
  readonly root: TestNode;
  readonly defaultFilePath: string | undefined;
  readonly defaultOnlyMode: boolean;
  readonly defaultTimeout: number | undefined;
  readonly testNamePatterns: ReadonlyArray<RegExp> | undefined;
  readonly testSkipPatterns: ReadonlyArray<RegExp> | undefined;
  readonly counts: TestSummaryCounts = {
    tests: 0,
    suites: 0,
    pass: 0,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    topLevel: 0,
  };

  readonly #sink: EventSink;
  readonly #isFileSubHarness: boolean;
  readonly #activeStack: TestNode[] = [];
  readonly #als: AsyncLocalStorageLike<TestNode | undefined> | undefined;
  #scheduled = false;
  #runningRoot = false;
  #rootStartNs: bigint | undefined;
  #rootDrainPromise:
    | Promise<{ success: boolean; counts: TestSummaryCounts; durationMs: number }>
    | undefined;

  constructor(
    deps: TestRunnerBuiltinsDeps,
    shared: {
      builtinsTarget?: Record<string, unknown>;
      assertRegistry: AssertRegistry;
      snapshotManager: SnapshotManager;
      mock: MockTracker;
    },
    fileContext?: FileHarnessContext,
  ) {
    this.deps = deps;
    this.builtinsTarget = shared.builtinsTarget;
    this.assertRegistry = shared.assertRegistry;
    this.snapshotManager = shared.snapshotManager;
    this.mock = shared.mock;
    this.defaultFilePath = fileContext?.filePath;
    const execArgv = getProcessExecArgv(deps);
    this.defaultOnlyMode = Boolean(fileContext?.onlyMode || execArgv.includes('--test-only'));
    this.defaultTimeout = fileContext?.timeout;
    this.testNamePatterns = fileContext?.testNamePatterns;
    this.testSkipPatterns = fileContext?.testSkipPatterns;
    this.#sink = fileContext?.sink ?? createDefaultStdoutSink(deps);
    this.#isFileSubHarness = Boolean(fileContext);
    this.#als = tryCreateAsyncContextStore<TestNode>(deps);

    this.root = new TestNode({
      harness: this,
      parent: undefined,
      kind: 'root',
      name: '<root>',
      location: fileContext ? { file: fileContext.filePath } : {},
      options: { signal: fileContext?.signal },
      fn: undefined,
    });
  }

  emit(event: TestsStreamEvent): void {
    this.#sink(event);
  }

  recordCount(
    nodeKind: 'root' | 'suite' | 'test',
    outcome: 'pass' | 'fail' | 'cancelled' | 'skipped' | 'todo',
  ): void {
    if (nodeKind === 'suite') {
      this.counts.suites += 1;
    } else if (nodeKind === 'test') {
      this.counts.tests += 1;
    }
    this.counts[outcome] += 1;
  }

  currentParent(): TestNode {
    const fromAls = this.#als?.getStore();
    if (fromAls) return fromAls;
    return this.#activeStack.length > 0
      ? this.#activeStack[this.#activeStack.length - 1]
      : this.root;
  }

  runInNodeScope<R>(node: TestNode, fn: () => R): R {
    this.#activeStack.push(node);
    try {
      if (this.#als) {
        return this.#als.run(node, fn);
      }
      return fn();
    } finally {
      this.#activeStack.pop();
    }
  }

  registerChild(
    explicitParent: TestNode | undefined,
    kind: 'suite' | 'test',
    nameArg: unknown,
    optionsArg: unknown,
    fnArg: unknown,
    preset?: Partial<TestOptions>,
  ): Promise<void> {
    const parsed = parseTestCall(nameArg, optionsArg, fnArg);
    if (preset) {
      Object.assign(parsed.options, preset);
    }
    const parent = explicitParent ?? this.currentParent();
    const location = extractCallerLocation(this.defaultFilePath);

    const node = new TestNode({
      harness: this,
      parent,
      kind,
      name: parsed.name,
      location,
      options: parsed.options,
      fn: parsed.fn,
    });

    parent.children.push(node);
    if (parent === this.root) {
      this.counts.topLevel += 1;
    }

    this.emit({
      type: 'test:enqueue',
      data: {
        nesting: node.nesting,
        name: node.name,
        type: kind,
        ...node.locationFields(),
      },
    });

    if (kind === 'suite') {
      node.discoverSuiteSynchronously();
    }

    if (parent === this.root) {
      this.scheduleRootExecution();
    } else {
      parent.startDynamicChildIfRunning(node);
    }

    return node.completion;
  }

  registerCurrentHook(kind: HookKind, fnArg: unknown, optionsArg: unknown): void {
    this.currentParent().registerHook(kind, fnArg, optionsArg);
  }

  private scheduleRootExecution(): void {
    if (this.#isFileSubHarness || this.#scheduled || this.#runningRoot) return;
    this.#scheduled = true;
    this.#rootStartNs ??= this.deps.hrtimeNs();
    this.deps.retain();
    this.deps.setImmediate(() => {
      this.#scheduled = false;
      void this.executeRootAuto();
    });
  }

  private async executeRootAuto(): Promise<void> {
    if (this.#runningRoot) return;
    this.#runningRoot = true;
    const startNs = this.#rootStartNs ?? this.deps.hrtimeNs();
    this.#rootStartNs = undefined;
    try {
      const failedCount = await this.root.drainChildren();
      const totalRun = this.root.children.length;
      this.emit({
        type: 'test:plan',
        data: {
          nesting: 0,
          count: totalRun,
        },
      });
      const durationMs = Number(this.deps.hrtimeNs() - startNs) / 1_000_000;
      for (const message of formatSummaryDiagnosticMessages(this.counts, durationMs)) {
        this.emit({
          type: 'test:diagnostic',
          data: {
            nesting: 0,
            message,
            level: 'info',
          },
        });
      }
      const success = failedCount === 0 && this.counts.fail === 0 && this.counts.cancelled === 0;
      this.emit({
        type: 'test:summary',
        data: {
          success,
          counts: { ...this.counts },
          duration_ms: durationMs,
        },
      });
      if (!success) {
        setProcessExitCode(this.deps, 1);
      }
    } finally {
      this.#runningRoot = false;
      this.deps.release();
    }
  }

  async drainFileHarness(): Promise<{
    success: boolean;
    counts: TestSummaryCounts;
    durationMs: number;
  }> {
    if (this.#rootDrainPromise) return this.#rootDrainPromise;
    this.#rootDrainPromise = (async () => {
      const startNs = this.deps.hrtimeNs();
      const failedCount = await this.root.drainChildren();
      const durationMs = Number(this.deps.hrtimeNs() - startNs) / 1_000_000;
      const success = failedCount === 0 && this.counts.fail === 0 && this.counts.cancelled === 0;
      return { success, counts: { ...this.counts }, durationMs };
    })();
    return this.#rootDrainPromise;
  }
}

export interface TestModuleController {
  readonly testExport: unknown;
  runWithFileHarness<R>(
    fileContext: FileHarnessContext,
    fn: () => Promise<R>,
  ): Promise<{
    result: R;
    summary: { success: boolean; counts: TestSummaryCounts; durationMs: number };
  }>;
}

export function createTestModuleController(
  deps: TestRunnerBuiltinsDeps,
  builtinsTarget?: Record<string, unknown>,
): TestModuleController {
  const assertRegistry = new AssertRegistry(deps);
  const snapshotManager = new SnapshotManager(deps);
  const rootMock = createMockTracker(deps, builtinsTarget);
  const defaultHarness = new HarnessInstance(deps, {
    builtinsTarget,
    assertRegistry,
    snapshotManager,
    mock: rootMock,
  });

  const fileHarnessStack: HarnessInstance[] = [];
  const activeHarness = (): HarnessInstance =>
    fileHarnessStack.length > 0 ? fileHarnessStack[fileHarnessStack.length - 1] : defaultHarness;

  const test = (name?: unknown, options?: unknown, fn?: unknown): Promise<void> =>
    activeHarness().registerChild(undefined, 'test', name, options, fn);

  const testOnly = (name?: unknown, options?: unknown, fn?: unknown): Promise<void> =>
    activeHarness().registerChild(undefined, 'test', name, options, fn, { only: true });

  const testSkip = (name?: unknown, options?: unknown, fn?: unknown): Promise<void> =>
    activeHarness().registerChild(undefined, 'test', name, options, fn, { skip: true });

  const testTodo = (name?: unknown, options?: unknown, fn?: unknown): Promise<void> =>
    activeHarness().registerChild(undefined, 'test', name, options, fn, { todo: true });

  const suite = (name?: unknown, options?: unknown, fn?: unknown): Promise<void> =>
    activeHarness().registerChild(undefined, 'suite', name, options, fn);

  const suiteOnly = (name?: unknown, options?: unknown, fn?: unknown): Promise<void> =>
    activeHarness().registerChild(undefined, 'suite', name, options, fn, { only: true });

  const suiteSkip = (name?: unknown, options?: unknown, fn?: unknown): Promise<void> =>
    activeHarness().registerChild(undefined, 'suite', name, options, fn, { skip: true });

  const suiteTodo = (name?: unknown, options?: unknown, fn?: unknown): Promise<void> =>
    activeHarness().registerChild(undefined, 'suite', name, options, fn, { todo: true });

  Object.defineProperties(suite, {
    name: { value: 'suite', writable: false, enumerable: false, configurable: true },
    skip: { value: suiteSkip, writable: true, enumerable: true, configurable: true },
    todo: { value: suiteTodo, writable: true, enumerable: true, configurable: true },
    only: { value: suiteOnly, writable: true, enumerable: true, configurable: true },
  });

  const before = (fn?: unknown, options?: unknown): void => {
    activeHarness().registerCurrentHook('before', fn, options);
  };
  const after = (fn?: unknown, options?: unknown): void => {
    activeHarness().registerCurrentHook('after', fn, options);
  };
  const beforeEach = (fn?: unknown, options?: unknown): void => {
    activeHarness().registerCurrentHook('beforeEach', fn, options);
  };
  const afterEach = (fn?: unknown, options?: unknown): void => {
    activeHarness().registerCurrentHook('afterEach', fn, options);
  };

  const controller: TestModuleController = {
    testExport: test,
    async runWithFileHarness<R>(
      fileContext: FileHarnessContext,
      fn: () => Promise<R>,
    ): Promise<{
      result: R;
      summary: { success: boolean; counts: TestSummaryCounts; durationMs: number };
    }> {
      const fileHarness = new HarnessInstance(
        deps,
        { builtinsTarget, assertRegistry, snapshotManager, mock: rootMock },
        fileContext,
      );
      fileHarnessStack.push(fileHarness);
      let result: R;
      try {
        result = await fn();
      } finally {
        fileHarnessStack.pop();
      }
      const summary = await fileHarness.drainFileHarness();
      return { result, summary };
    },
  };

  const runFn = createRunFunction(deps, controller, snapshotManager);
  const assertNamespace = assertRegistry.createNamespace();
  const snapshotNamespace = snapshotManager.createNamespace();

  Object.defineProperties(test, {
    name: { value: 'test', writable: false, enumerable: false, configurable: true },
    skip: { value: testSkip, writable: true, enumerable: true, configurable: true },
    todo: { value: testTodo, writable: true, enumerable: true, configurable: true },
    only: { value: testOnly, writable: true, enumerable: true, configurable: true },
    after: { value: after, writable: true, enumerable: true, configurable: true },
    afterEach: { value: afterEach, writable: true, enumerable: true, configurable: true },
    before: { value: before, writable: true, enumerable: true, configurable: true },
    beforeEach: { value: beforeEach, writable: true, enumerable: true, configurable: true },
    describe: { value: suite, writable: true, enumerable: true, configurable: true },
    it: { value: test, writable: true, enumerable: true, configurable: true },
    run: { value: runFn, writable: true, enumerable: true, configurable: true },
    suite: { value: suite, writable: true, enumerable: true, configurable: true },
    test: { value: test, writable: true, enumerable: true, configurable: true },
    mock: {
      get() {
        return rootMock;
      },
      enumerable: true,
      configurable: true,
    },
    snapshot: {
      get() {
        return snapshotNamespace;
      },
      enumerable: true,
      configurable: true,
    },
    assert: {
      get() {
        return assertNamespace;
      },
      enumerable: true,
      configurable: true,
    },
  });

  return controller;
}
