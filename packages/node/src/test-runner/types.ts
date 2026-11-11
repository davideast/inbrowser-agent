import type { TestRunnerBuiltinsDeps } from '../builtins/test-runner';

export type TestFailureType =
  | 'testCodeFailure'
  | 'hookFailed'
  | 'subtestsFailed'
  | 'cancelledByParent'
  | 'testTimeoutFailure'
  | 'uncaughtException'
  | 'unhandledRejection';

export interface TestFailureError extends Error {
  code: 'ERR_TEST_FAILURE';
  failureType: TestFailureType;
  cause: unknown;
}

export interface CodedError extends Error {
  code: string;
}

export interface SourceLocation {
  file?: string;
  line?: number;
  column?: number;
}

export interface TestSummaryCounts {
  tests: number;
  suites: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
  todo: number;
  topLevel: number;
}

export interface TestEnqueueDequeueData extends SourceLocation {
  nesting: number;
  name: string;
  type: 'test' | 'suite';
}

export interface TestStartData extends SourceLocation {
  nesting: number;
  name: string;
}

export interface TestResultDetails {
  duration_ms: number;
  type?: 'test' | 'suite';
  passed?: boolean;
  error?: Error;
}

export interface TestOutcomeData extends SourceLocation {
  name: string;
  nesting: number;
  testNumber: number;
  details: TestResultDetails;
  skip?: string | boolean;
  todo?: string | boolean;
}

export interface TestPlanData extends SourceLocation {
  nesting: number;
  count: number;
}

export interface TestDiagnosticData extends SourceLocation {
  nesting: number;
  message: string;
  level?: 'info' | 'warn' | 'error';
}

export interface TestStdioData {
  file: string;
  line?: number;
  column?: number;
  message: string;
}

export interface TestSummaryData {
  success: boolean;
  counts: TestSummaryCounts;
  duration_ms: number;
  file?: string;
}

export interface CoverageLineEntry {
  line: number;
  count: number;
}

export interface CoverageBranchEntry {
  line: number;
  count: number;
}

export interface CoverageFunctionEntry {
  name: string;
  line: number;
  count: number;
}

export interface CoverageFileSummary {
  path: string;
  totalLineCount: number;
  totalBranchCount: number;
  totalFunctionCount: number;
  coveredLineCount: number;
  coveredBranchCount: number;
  coveredFunctionCount: number;
  coveredLinePercent: number;
  coveredBranchPercent: number;
  coveredFunctionPercent: number;
  functions: CoverageFunctionEntry[];
  branches: CoverageBranchEntry[];
  lines: CoverageLineEntry[];
}

export interface TestCoverageData {
  nesting: number;
  summary: {
    workingDirectory: string;
    files: CoverageFileSummary[];
    totals?: Record<string, number>;
  };
}

export type TestsStreamEvent =
  | { type: 'test:enqueue'; data: TestEnqueueDequeueData }
  | { type: 'test:dequeue'; data: TestEnqueueDequeueData }
  | { type: 'test:start'; data: TestStartData }
  | { type: 'test:pass'; data: TestOutcomeData }
  | { type: 'test:fail'; data: TestOutcomeData }
  | { type: 'test:complete'; data: TestOutcomeData }
  | { type: 'test:plan'; data: TestPlanData }
  | { type: 'test:diagnostic'; data: TestDiagnosticData }
  | { type: 'test:stdout'; data: TestStdioData }
  | { type: 'test:stderr'; data: TestStdioData }
  | { type: 'test:coverage'; data: TestCoverageData }
  | { type: 'test:summary'; data: TestSummaryData }
  | { type: 'test:watch:drained'; data: undefined };

export type EventSink = (event: TestsStreamEvent) => void;

export interface TestOptions {
  concurrency?: number | boolean;
  only?: boolean;
  signal?: AbortSignal;
  skip?: boolean | string;
  timeout?: number;
  todo?: boolean | string;
  plan?: number;
}

export interface HookOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface WaitForOptions {
  interval?: number;
  timeout?: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' &&
      value !== null &&
      'then' in value &&
      typeof value.then === 'function') ||
    (typeof value === 'function' && 'then' in value && typeof value.then === 'function')
  );
}

export function formatSummaryDiagnosticMessages(
  counts: TestSummaryCounts,
  durationMs: number,
): string[] {
  return [
    `tests ${counts.tests}`,
    `suites ${counts.suites}`,
    `pass ${counts.pass}`,
    `fail ${counts.fail}`,
    `cancelled ${counts.cancelled}`,
    `skipped ${counts.skipped}`,
    `todo ${counts.todo}`,
    `duration_ms ${durationMs}`,
  ];
}

export function describeReceivedValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') {
    return `function ${value.name || ''}`.trim();
  }
  if (typeof value === 'object') {
    const ctorName = value.constructor?.name;
    return ctorName ? `an instance of ${ctorName}` : 'Object';
  }
  if (typeof value === 'string') {
    return `type string (${JSON.stringify(value)})`;
  }
  return `type ${typeof value} (${String(value)})`;
}

export function createInvalidArgType(name: string, expected: string, actual: unknown): CodedError {
  const err = new TypeError(
    `The "${name}" argument must be ${expected}. Received ${describeReceivedValue(actual)}`,
  );
  return Object.assign(err, { code: 'ERR_INVALID_ARG_TYPE' });
}

export function createInvalidArgValue(
  name: string,
  value: unknown,
  reason = 'is invalid',
): CodedError {
  const rendered = typeof value === 'string' ? JSON.stringify(value) : String(value);
  const err = new TypeError(`The argument '${name}' ${reason}. Received ${rendered}`);
  return Object.assign(err, { code: 'ERR_INVALID_ARG_VALUE' });
}

export function createInvalidState(message: string): CodedError {
  const err = new Error(message);
  return Object.assign(err, { code: 'ERR_INVALID_STATE' });
}

export function createTestFailureError(
  cause: unknown,
  failureType: TestFailureType,
): TestFailureError {
  if (
    cause instanceof Error &&
    'code' in cause &&
    cause.code === 'ERR_TEST_FAILURE' &&
    'failureType' in cause &&
    typeof cause.failureType === 'string'
  ) {
    // Invariant: narrowed to an existing ERR_TEST_FAILURE Error object above.
    return cause as TestFailureError;
  }
  const message =
    cause instanceof Error
      ? cause.message
      : isRecord(cause) && typeof cause.message === 'string'
        ? cause.message
        : typeof cause === 'string'
          ? cause
          : String(cause);
  const err = new Error(message);
  if (cause instanceof Error && cause.stack) {
    err.stack = cause.stack;
  }
  return Object.assign(err, {
    code: 'ERR_TEST_FAILURE' as const,
    failureType,
    cause,
  });
}

export function inspectWithDeps(
  deps: TestRunnerBuiltinsDeps,
  value: unknown,
  options?: Record<string, unknown>,
): string {
  const inspectFn = deps.util.inspect;
  if (typeof inspectFn === 'function') {
    const out = inspectFn(value, options);
    if (typeof out === 'string') return out;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getProcessExecArgv(deps: TestRunnerBuiltinsDeps): string[] {
  if (!isRecord(deps.process)) return [];
  const raw = deps.process.execArgv;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

export function getProcessArgv(deps: TestRunnerBuiltinsDeps): string[] {
  if (!isRecord(deps.process)) return [];
  const raw = deps.process.argv;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

export function setProcessExitCode(deps: TestRunnerBuiltinsDeps, code: number): void {
  if (isRecord(deps.process)) {
    deps.process.exitCode = code;
  }
}

export function writeProcessStdout(deps: TestRunnerBuiltinsDeps, chunk: string): void {
  if (!isRecord(deps.process)) return;
  const stdout = deps.process.stdout;
  if (isRecord(stdout) && typeof stdout.write === 'function') {
    stdout.write.call(stdout, chunk);
  }
}

export function isProcessStdoutTTY(deps: TestRunnerBuiltinsDeps): boolean {
  if (!isRecord(deps.process)) return false;
  const stdout = deps.process.stdout;
  return isRecord(stdout) && stdout.isTTY === true;
}

export function extractCallerLocation(fallbackFile?: string): SourceLocation {
  const stack = new Error().stack;
  if (typeof stack === 'string') {
    const lines = stack.split('\n').slice(1);
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (
        trimmed.includes('/test-runner/') ||
        trimmed.includes('/builtins/test-runner') ||
        trimmed.includes('/process.js') ||
        trimmed.includes('/runtime.js') ||
        trimmed.includes('node:internal/') ||
        trimmed.includes('/node_modules/') ||
        trimmed.includes('.unit.test.')
      ) {
        continue;
      }
      const match =
        /\(([^()]+):(\d+):(\d+)\)$/.exec(trimmed) ?? /at\s+([^\s()]+):(\d+):(\d+)$/.exec(trimmed);
      if (!match) continue;
      let file = match[1];
      if (
        file.startsWith('[eval]') ||
        file.startsWith('evalmachine') ||
        file.startsWith('blob:') ||
        file.startsWith('http://') ||
        file.startsWith('https://')
      ) {
        continue;
      }
      if (file.startsWith('file://')) {
        try {
          file = decodeURIComponent(new URL(file).pathname);
        } catch {
          continue;
        }
      }
      if (!file.startsWith('/')) continue;
      return {
        file,
        line: Number.parseInt(match[2], 10),
        column: Number.parseInt(match[3], 10),
      };
    }
  }
  if (fallbackFile) {
    return { file: fallbackFile, line: 1, column: 1 };
  }
  return {};
}
