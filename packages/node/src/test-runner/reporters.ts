import path from 'path-browserify';
import type { TestRunnerBuiltinsDeps } from '../builtins/test-runner';
import {
  type CoverageFileSummary,
  type EventSink,
  type TestsStreamEvent,
  isProcessStdoutTTY,
  isRecord,
  writeProcessStdout,
} from './types';

interface ReadableInstance {
  push(chunk: unknown): boolean;
  emit(event: string, ...args: unknown[]): boolean;
  compose(stream: unknown): AsyncIterable<unknown>;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

interface ReadableConstructor {
  new (options?: {
    objectMode?: boolean;
    read?: (this: ReadableInstance, size: number) => void;
  }): ReadableInstance;
}

interface TransformInstance {
  push(chunk: unknown): boolean;
}

interface TransformConstructor {
  new (options?: {
    writableObjectMode?: boolean;
    readableObjectMode?: boolean;
    transform?: (
      this: TransformInstance,
      chunk: unknown,
      encoding: string,
      callback: (error?: Error | null, data?: unknown) => void,
    ) => void;
    flush?: (
      this: TransformInstance,
      callback: (error?: Error | null, data?: unknown) => void,
    ) => void;
  }): TransformInstance;
}

function getStreamConstructors(deps: TestRunnerBuiltinsDeps): {
  Readable: ReadableConstructor;
  Transform: TransformConstructor;
} {
  const s = deps.stream;
  if (
    (isRecord(s) || typeof s === 'function') &&
    'Readable' in s &&
    typeof s.Readable === 'function' &&
    'Transform' in s &&
    typeof s.Transform === 'function'
  ) {
    return {
      // Invariant: narrowed s.Readable to a constructor function above.
      Readable: s.Readable as ReadableConstructor,
      // Invariant: narrowed s.Transform to a constructor function above.
      Transform: s.Transform as TransformConstructor,
    };
  }
  throw new Error('TestRunnerBuiltinsDeps.stream is missing Readable/Transform constructors');
}

export interface TestsStreamHandle extends ReadableInstance {
  emitEvent(event: TestsStreamEvent): void;
  endStream(): void;
}

export function createTestsStream(deps: TestRunnerBuiltinsDeps): TestsStreamHandle {
  const { Readable } = getStreamConstructors(deps);
  const buffer: Array<TestsStreamEvent | null> = [];
  let reading = false;

  const stream = new Readable({
    objectMode: true,
    read() {
      reading = true;
      while (buffer.length > 0) {
        const next = buffer.shift() ?? null;
        if (!this.push(next)) {
          reading = false;
          break;
        }
        if (next === null) {
          reading = false;
          break;
        }
      }
    },
  });

  const flushIfReading = (): void => {
    if (!reading) return;
    while (buffer.length > 0) {
      const next = buffer.shift() ?? null;
      if (!stream.push(next)) {
        reading = false;
        break;
      }
      if (next === null) {
        reading = false;
        break;
      }
    }
  };

  return Object.assign(stream, {
    emitEvent(event: TestsStreamEvent): void {
      stream.emit(event.type, event.data);
      buffer.push(event);
      flushIfReading();
    },
    endStream(): void {
      buffer.push(null);
      flushIfReading();
    },
  });
}

function escapeTapText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/#/g, '\\#').replace(/\r?\n/g, ' ');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeXmlComment(value: string): string {
  return value.replace(/--/g, '- -');
}

function readNesting(data: unknown): number {
  return isRecord(data) && typeof data.nesting === 'number' && data.nesting >= 0 ? data.nesting : 0;
}

function readEventName(data: unknown): string {
  return isRecord(data) && typeof data.name === 'string' ? data.name : '';
}

function readDetails(data: unknown): {
  durationMs: number;
  type?: string;
  error?: unknown;
} {
  if (!isRecord(data) || !isRecord(data.details)) {
    return { durationMs: 0 };
  }
  const durationMs = typeof data.details.duration_ms === 'number' ? data.details.duration_ms : 0;
  const type = typeof data.details.type === 'string' ? data.details.type : undefined;
  return { durationMs, type, error: data.details.error };
}

function readErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (isRecord(err) && typeof err.message === 'string') return err.message;
  return String(err ?? '');
}

function formatTapItem(rawEvent: unknown, state: { headerPrinted: boolean }): string {
  if (!isRecord(rawEvent) || typeof rawEvent.type !== 'string') return '';
  let out = '';
  if (!state.headerPrinted) {
    state.headerPrinted = true;
    out += 'TAP version 13\n';
  }
  const data = rawEvent.data;
  const nesting = readNesting(data);
  const indent = '    '.repeat(nesting);

  switch (rawEvent.type) {
    case 'test:start': {
      out += `${indent}# Subtest: ${escapeTapText(readEventName(data))}\n`;
      break;
    }
    case 'test:pass':
    case 'test:fail': {
      const status = rawEvent.type === 'test:pass' ? 'ok' : 'not ok';
      const testNumber =
        isRecord(data) && typeof data.testNumber === 'number' ? data.testNumber : 1;
      let directive = '';
      if (isRecord(data) && data.skip !== undefined && data.skip !== false) {
        directive =
          typeof data.skip === 'string' && data.skip.length > 0
            ? ` # SKIP ${escapeTapText(data.skip)}`
            : ' # SKIP';
      } else if (isRecord(data) && data.todo !== undefined && data.todo !== false) {
        directive =
          typeof data.todo === 'string' && data.todo.length > 0
            ? ` # TODO ${escapeTapText(data.todo)}`
            : ' # TODO';
      }
      const details = readDetails(data);
      out += `${indent}${status} ${testNumber} - ${escapeTapText(readEventName(data))}${directive}\n`;
      out += `${indent}  ---\n`;
      out += `${indent}  duration_ms: ${details.durationMs}\n`;
      if (details.type) {
        out += `${indent}  type: '${details.type}'\n`;
      }
      if (
        rawEvent.type === 'test:fail' &&
        isRecord(data) &&
        typeof data.file === 'string' &&
        typeof data.line === 'number' &&
        typeof data.column === 'number'
      ) {
        out += `${indent}  location: '${data.file}:${data.line}:${data.column}'\n`;
      }
      if (rawEvent.type === 'test:fail' && details.error !== undefined) {
        const err = details.error;
        if (isRecord(err) && typeof err.failureType === 'string') {
          out += `${indent}  failureType: '${err.failureType}'\n`;
        }
        out += `${indent}  error: ${JSON.stringify(readErrorMessage(err))}\n`;
        if (isRecord(err) && typeof err.code === 'string') {
          out += `${indent}  code: '${err.code}'\n`;
        }
      }
      out += `${indent}  ...\n`;
      break;
    }
    case 'test:plan': {
      const count = isRecord(data) && typeof data.count === 'number' ? data.count : 0;
      out += `${indent}1..${count}\n`;
      break;
    }
    case 'test:diagnostic': {
      const msg = isRecord(data) && typeof data.message === 'string' ? data.message : '';
      for (const line of msg.split(/\r?\n/)) {
        out += `${indent}# ${line}\n`;
      }
      break;
    }
    case 'test:stdout':
    case 'test:stderr': {
      const msg = isRecord(data) && typeof data.message === 'string' ? data.message : '';
      for (const line of msg.split(/\r?\n/)) {
        if (line.length > 0) {
          out += `${indent}# ${line}\n`;
        }
      }
      break;
    }
    default:
      break;
  }
  return out;
}

async function* tapReporter(source: AsyncIterable<unknown>): AsyncGenerator<string> {
  const state = { headerPrinted: false };
  for await (const event of source) {
    const chunk = formatTapItem(event, state);
    if (chunk.length > 0) {
      yield chunk;
    }
  }
}

async function* dotReporter(source: AsyncIterable<unknown>): AsyncGenerator<string> {
  const columns = 80;
  let col = 0;
  const failed: Array<{ name: string; message: string }> = [];

  for await (const rawEvent of source) {
    if (!isRecord(rawEvent) || typeof rawEvent.type !== 'string') continue;
    if (rawEvent.type === 'test:pass' || rawEvent.type === 'test:fail') {
      const symbol = rawEvent.type === 'test:pass' ? '.' : 'X';
      yield symbol;
      col += 1;
      if (col >= columns) {
        yield '\n';
        col = 0;
      }
      if (rawEvent.type === 'test:fail') {
        const details = readDetails(rawEvent.data);
        if (details.type !== 'suite') {
          failed.push({
            name: readEventName(rawEvent.data),
            message: readErrorMessage(details.error),
          });
        }
      }
    }
  }
  yield '\n';
  if (failed.length > 0) {
    let summary = '\nFailed tests:\n\n';
    for (const item of failed) {
      summary += `${item.name}:\n  ${item.message}\n`;
    }
    yield summary;
  }
}

interface JunitNode {
  kind: 'root' | 'node' | 'comment';
  name: string;
  nesting: number;
  durationSec: string;
  type?: string;
  skip?: string | boolean;
  todo?: string | boolean;
  error?: unknown;
  children: JunitNode[];
  comment?: string;
}

function renderJunitNode(node: JunitNode, depth: number, hostname: string): string {
  const indent = '\t'.repeat(depth);
  if (node.kind === 'comment') {
    return `${indent}<!-- ${escapeXmlComment(node.comment ?? '')} -->\n`;
  }
  const hasTestChildren = node.children.some((c) => c.kind === 'node');
  const isSuite = node.type === 'suite' || hasTestChildren;

  if (isSuite) {
    let tests = 0;
    let failures = 0;
    let skipped = 0;
    for (const child of node.children) {
      if (child.kind !== 'node') continue;
      tests += 1;
      if (
        (child.skip !== undefined && child.skip !== false) ||
        (child.todo !== undefined && child.todo !== false)
      ) {
        skipped += 1;
      } else if (child.error !== undefined) {
        failures += 1;
      }
    }
    let xml = `${indent}<testsuite name="${escapeXml(node.name)}" time="${node.durationSec}" disabled="0" errors="0" tests="${tests}" failures="${failures}" skipped="${skipped}" hostname="${escapeXml(hostname)}">\n`;
    for (const child of node.children) {
      xml += renderJunitNode(child, depth + 1, hostname);
    }
    xml += `${indent}</testsuite>\n`;
    return xml;
  }

  const attrs = `name="${escapeXml(node.name)}" time="${node.durationSec}" classname="test"`;
  if (node.skip !== undefined && node.skip !== false) {
    const msgAttr =
      typeof node.skip === 'string' && node.skip.length > 0
        ? ` message="${escapeXml(node.skip)}"`
        : '';
    return `${indent}<testcase ${attrs}>\n${indent}\t<skipped type="skipped"${msgAttr}/>\n${indent}</testcase>\n`;
  }
  if (node.todo !== undefined && node.todo !== false) {
    const msgAttr =
      typeof node.todo === 'string' && node.todo.length > 0
        ? ` message="${escapeXml(node.todo)}"`
        : '';
    return `${indent}<testcase ${attrs}>\n${indent}\t<skipped type="todo"${msgAttr}/>\n${indent}</testcase>\n`;
  }
  if (node.error !== undefined) {
    const errMsg = readErrorMessage(node.error);
    const failureType =
      isRecord(node.error) && typeof node.error.failureType === 'string'
        ? node.error.failureType
        : 'testCodeFailure';
    const stackText = node.error instanceof Error && node.error.stack ? node.error.stack : errMsg;
    return `${indent}<testcase ${attrs}>\n${indent}\t<failure type="${escapeXml(failureType)}" message="${escapeXml(errMsg)}">\n${escapeXml(stackText)}\n${indent}\t</failure>\n${indent}</testcase>\n`;
  }
  return `${indent}<testcase ${attrs}/>\n`;
}

function createJunitReporter(deps: TestRunnerBuiltinsDeps) {
  let hostname = 'localhost';
  try {
    const osMod = deps.loadModule('node:os');
    if (isRecord(osMod) && typeof osMod.hostname === 'function') {
      const h = osMod.hostname();
      if (typeof h === 'string' && h.length > 0) hostname = h;
    }
  } catch {
    // Default to localhost.
  }

  return async function* junitReporter(source: AsyncIterable<unknown>): AsyncGenerator<string> {
    yield '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n';
    const root: JunitNode = {
      kind: 'root',
      name: 'root',
      nesting: -1,
      durationSec: '0.000000',
      children: [],
    };
    const stack: JunitNode[] = [root];

    for await (const rawEvent of source) {
      if (!isRecord(rawEvent) || typeof rawEvent.type !== 'string') continue;
      const data = rawEvent.data;
      const nesting = readNesting(data);

      if (rawEvent.type === 'test:start') {
        while (stack.length > 1 && stack[stack.length - 1].nesting >= nesting) {
          stack.pop();
        }
        const node: JunitNode = {
          kind: 'node',
          name: readEventName(data),
          nesting,
          durationSec: '0.000000',
          children: [],
        };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      } else if (rawEvent.type === 'test:pass' || rawEvent.type === 'test:fail') {
        while (stack.length > 1 && stack[stack.length - 1].nesting > nesting) {
          stack.pop();
        }
        let target = stack[stack.length - 1];
        if (target === root || target.nesting !== nesting) {
          target = {
            kind: 'node',
            name: readEventName(data),
            nesting,
            durationSec: '0.000000',
            children: [],
          };
          root.children.push(target);
        } else {
          stack.pop();
        }
        const details = readDetails(data);
        target.durationSec = (details.durationMs / 1000).toFixed(6);
        target.type = details.type;
        if (isRecord(data)) {
          if (data.skip !== undefined) {
            target.skip = typeof data.skip === 'string' ? data.skip : Boolean(data.skip);
          }
          if (data.todo !== undefined) {
            target.todo = typeof data.todo === 'string' ? data.todo : Boolean(data.todo);
          }
        }
        if (rawEvent.type === 'test:fail') {
          target.error = details.error ?? new Error('Test failed');
        }
        if (target.nesting === 0) {
          const idx = root.children.indexOf(target);
          if (idx !== -1) root.children.splice(idx, 1);
          yield renderJunitNode(target, 1, hostname);
        }
      } else if (rawEvent.type === 'test:diagnostic') {
        const msg = isRecord(data) && typeof data.message === 'string' ? data.message : '';
        const commentNode: JunitNode = {
          kind: 'comment',
          name: '',
          nesting,
          durationSec: '0',
          children: [],
          comment: msg,
        };
        if (nesting === 0 && stack.length === 1) {
          yield renderJunitNode(commentNode, 1, hostname);
        } else {
          stack[stack.length - 1].children.push(commentNode);
        }
      }
    }

    for (const remaining of root.children) {
      yield renderJunitNode(remaining, 1, hostname);
    }
    yield '</testsuites>\n';
  };
}

class SpecFormatter {
  readonly #pendingStarts: Array<{ nesting: number; name: string; printed: boolean }> = [];
  readonly #failedTests: Array<{ name: string; message: string }> = [];

  formatEvent(rawEvent: unknown): string {
    if (!isRecord(rawEvent) || typeof rawEvent.type !== 'string') return '';
    const data = rawEvent.data;
    const nesting = readNesting(data);
    let out = '';

    const flushAncestorsUpTo = (maxNesting: number): void => {
      for (const entry of this.#pendingStarts) {
        if (entry.nesting < maxNesting && !entry.printed) {
          entry.printed = true;
          out += `${'  '.repeat(entry.nesting)}▶ ${entry.name}\n`;
        }
      }
    };

    switch (rawEvent.type) {
      case 'test:start': {
        while (
          this.#pendingStarts.length > 0 &&
          this.#pendingStarts[this.#pendingStarts.length - 1].nesting >= nesting
        ) {
          this.#pendingStarts.pop();
        }
        flushAncestorsUpTo(nesting);
        this.#pendingStarts.push({
          nesting,
          name: readEventName(data),
          printed: false,
        });
        break;
      }
      case 'test:pass':
      case 'test:fail': {
        flushAncestorsUpTo(nesting);
        let hadPrintedHeader = false;
        while (
          this.#pendingStarts.length > 0 &&
          this.#pendingStarts[this.#pendingStarts.length - 1].nesting >= nesting
        ) {
          const popped = this.#pendingStarts.pop();
          if (popped && popped.nesting === nesting && popped.printed) {
            hadPrintedHeader = true;
          }
        }
        const details = readDetails(data);
        const indent = '  '.repeat(nesting);
        const skipVal = isRecord(data) ? data.skip : undefined;
        const todoVal = isRecord(data) ? data.todo : undefined;
        let symbol = rawEvent.type === 'test:pass' ? '✔' : '✖';
        let suffix = '';
        if (skipVal !== undefined && skipVal !== false) {
          symbol = '﹣';
          if (typeof skipVal === 'string' && skipVal.length > 0) {
            suffix = ` # ${skipVal}`;
          }
        } else if (todoVal !== undefined && todoVal !== false) {
          if (typeof todoVal === 'string' && todoVal.length > 0) {
            suffix = ` # ${todoVal}`;
          } else {
            suffix = ' # TODO';
          }
        }
        out += `${indent}${symbol} ${readEventName(data)} (${details.durationMs}ms)${suffix}\n`;
        if (rawEvent.type === 'test:fail' && !hadPrintedHeader && details.type !== 'suite') {
          this.#failedTests.push({
            name: readEventName(data),
            message: readErrorMessage(details.error),
          });
        }
        break;
      }
      case 'test:diagnostic': {
        flushAncestorsUpTo(nesting + 1);
        const indent = '  '.repeat(nesting);
        const msg = isRecord(data) && typeof data.message === 'string' ? data.message : '';
        for (const line of msg.split(/\r?\n/)) {
          out += `${indent}ℹ ${line}\n`;
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  flushSummary(): string {
    if (this.#failedTests.length === 0) return '';
    let out = '\n✖ failing tests:\n\n';
    for (const fail of this.#failedTests) {
      out += `✖ ${fail.name}\n  ${fail.message}\n`;
    }
    return out;
  }
}

function readCoverageFiles(rawFiles: ReadonlyArray<unknown>): CoverageFileSummary[] {
  const out: CoverageFileSummary[] = [];
  for (const item of rawFiles) {
    if (!isRecord(item) || typeof item.path !== 'string') continue;
    const functions = Array.isArray(item.functions)
      ? item.functions
          .filter((f): f is Record<string, unknown> => isRecord(f))
          .map((f) => ({
            name: typeof f.name === 'string' ? f.name : '<anonymous>',
            line: typeof f.line === 'number' ? f.line : 0,
            count: typeof f.count === 'number' ? f.count : 0,
          }))
      : [];
    const branches = Array.isArray(item.branches)
      ? item.branches
          .filter((b): b is Record<string, unknown> => isRecord(b))
          .map((b) => ({
            line: typeof b.line === 'number' ? b.line : 0,
            count: typeof b.count === 'number' ? b.count : 0,
          }))
      : [];
    const lines = Array.isArray(item.lines)
      ? item.lines
          .filter((l): l is Record<string, unknown> => isRecord(l))
          .map((l) => ({
            line: typeof l.line === 'number' ? l.line : 0,
            count: typeof l.count === 'number' ? l.count : 0,
          }))
      : [];
    out.push({
      path: item.path,
      totalLineCount: typeof item.totalLineCount === 'number' ? item.totalLineCount : 0,
      totalBranchCount: typeof item.totalBranchCount === 'number' ? item.totalBranchCount : 0,
      totalFunctionCount: typeof item.totalFunctionCount === 'number' ? item.totalFunctionCount : 0,
      coveredLineCount: typeof item.coveredLineCount === 'number' ? item.coveredLineCount : 0,
      coveredBranchCount: typeof item.coveredBranchCount === 'number' ? item.coveredBranchCount : 0,
      coveredFunctionCount:
        typeof item.coveredFunctionCount === 'number' ? item.coveredFunctionCount : 0,
      coveredLinePercent: typeof item.coveredLinePercent === 'number' ? item.coveredLinePercent : 0,
      coveredBranchPercent:
        typeof item.coveredBranchPercent === 'number' ? item.coveredBranchPercent : 0,
      coveredFunctionPercent:
        typeof item.coveredFunctionPercent === 'number' ? item.coveredFunctionPercent : 0,
      functions,
      branches,
      lines,
    });
  }
  return out;
}

function formatLcovSummary(
  workingDirectory: string,
  files: ReadonlyArray<CoverageFileSummary>,
): string {
  let out = '';
  for (const file of files) {
    const rel = path.relative(workingDirectory, file.path) || file.path;
    out += `TN:\nSF:${rel}\n`;
    for (const fn of file.functions ?? []) {
      out += `FN:${fn.line},${fn.name}\n`;
    }
    for (const fn of file.functions ?? []) {
      out += `FNDA:${fn.count},${fn.name}\n`;
    }
    out += `FNF:${file.totalFunctionCount ?? 0}\n`;
    out += `FNH:${file.coveredFunctionCount ?? 0}\n`;
    const branches = file.branches ?? [];
    for (let i = 0; i < branches.length; i += 1) {
      const br = branches[i];
      out += `BRDA:${br.line},${i},0,${br.count}\n`;
    }
    out += `BRF:${file.totalBranchCount ?? 0}\n`;
    out += `BRH:${file.coveredBranchCount ?? 0}\n`;
    for (const line of file.lines ?? []) {
      out += `DA:${line.line},${line.count}\n`;
    }
    out += `LH:${file.coveredLineCount ?? 0}\n`;
    out += `LF:${file.totalLineCount ?? 0}\n`;
    out += 'end_of_record\n';
  }
  return out;
}

export function createDefaultStdoutSink(deps: TestRunnerBuiltinsDeps): EventSink {
  const tapState = { headerPrinted: false };
  const specFormatter = new SpecFormatter();
  return (event: TestsStreamEvent): void => {
    if (isProcessStdoutTTY(deps)) {
      const chunk = specFormatter.formatEvent(event);
      if (chunk) writeProcessStdout(deps, chunk);
      if (event.type === 'test:summary' && event.data.file === undefined) {
        const tail = specFormatter.flushSummary();
        if (tail) writeProcessStdout(deps, tail);
      }
    } else {
      const chunk = formatTapItem(event, tapState);
      if (chunk) writeProcessStdout(deps, chunk);
    }
  };
}

export function createReportersModule(deps: TestRunnerBuiltinsDeps): Record<string, unknown> {
  const { Transform } = getStreamConstructors(deps);
  const junit = createJunitReporter(deps);

  function createSpecTransform(): TransformInstance {
    const formatter = new SpecFormatter();
    return new Transform({
      writableObjectMode: true,
      transform(chunk, _encoding, callback) {
        const text = formatter.formatEvent(chunk);
        if (text.length > 0) {
          this.push(text);
        }
        callback();
      },
      flush(callback) {
        const tail = formatter.flushSummary();
        if (tail.length > 0) {
          this.push(tail);
        }
        callback();
      },
    });
  }

  function spec(): TransformInstance {
    return createSpecTransform();
  }

  function createLcovTransform(): TransformInstance {
    return new Transform({
      writableObjectMode: true,
      transform(chunk, _encoding, callback) {
        if (
          isRecord(chunk) &&
          chunk.type === 'test:coverage' &&
          isRecord(chunk.data) &&
          isRecord(chunk.data.summary) &&
          Array.isArray(chunk.data.summary.files)
        ) {
          const workingDir =
            typeof chunk.data.summary.workingDirectory === 'string'
              ? chunk.data.summary.workingDirectory
              : deps.cwd();
          const text = formatLcovSummary(workingDir, readCoverageFiles(chunk.data.summary.files));
          if (text.length > 0) {
            this.push(text);
          }
        }
        callback();
      },
    });
  }

  const reporters: Record<string, unknown> = {};
  Object.defineProperties(reporters, {
    dot: {
      get() {
        return dotReporter;
      },
      enumerable: true,
      configurable: true,
    },
    junit: {
      get() {
        return junit;
      },
      enumerable: true,
      configurable: true,
    },
    spec: {
      value: spec,
      writable: false,
      enumerable: true,
      configurable: true,
    },
    tap: {
      get() {
        return tapReporter;
      },
      enumerable: true,
      configurable: true,
    },
    lcov: {
      get() {
        return createLcovTransform();
      },
      enumerable: true,
      configurable: true,
    },
  });

  return reporters;
}
