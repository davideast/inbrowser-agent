import path from 'path-browserify';
import type { TestRunnerBuiltinsDeps } from '../builtins/test-runner';
import { Matcher } from '../glob-match';
import type { FileHarnessContext } from './harness';
import { type TestsStreamHandle, createTestsStream } from './reporters';
import type { SnapshotManager } from './snapshot';
import {
  type TestSummaryCounts,
  createInvalidArgType,
  createInvalidArgValue,
  createTestFailureError,
  formatSummaryDiagnosticMessages,
  isRecord,
} from './types';

export interface RunHarnessBridge {
  runWithFileHarness<R>(
    fileContext: FileHarnessContext,
    fn: () => Promise<R>,
  ): Promise<{
    result: R;
    summary: { success: boolean; counts: TestSummaryCounts; durationMs: number };
  }>;
}

export interface RunOptions {
  concurrency?: number | boolean;
  cwd?: string;
  files?: ReadonlyArray<string>;
  globPatterns?: ReadonlyArray<string>;
  only?: boolean;
  setup?: (root: TestsStreamHandle) => unknown;
  signal?: AbortSignal;
  timeout?: number;
  argv?: ReadonlyArray<string>;
  execArgv?: ReadonlyArray<string>;
  isolation?: 'process' | 'none';
  shard?: { index: number; total: number };
  testNamePatterns?: string | RegExp | ReadonlyArray<string | RegExp>;
  testSkipPatterns?: string | RegExp | ReadonlyArray<string | RegExp>;
  updateSnapshots?: boolean;
}

const DEFAULT_TEST_GLOBS: ReadonlyArray<string> = [
  '**/test/**/*.{cjs,mjs,js}',
  '**/*.test.{cjs,mjs,js}',
  '**/*-test.{cjs,mjs,js}',
  '**/*_test.{cjs,mjs,js}',
  '**/test-*.{cjs,mjs,js}',
  '**/test.{cjs,mjs,js}',
];

function normalizePatternList(
  optionName: string,
  input: unknown,
): ReadonlyArray<RegExp> | undefined {
  if (input === undefined) return undefined;
  const items = Array.isArray(input) ? input : [input];
  const out: RegExp[] = [];
  for (const item of items) {
    if (item instanceof RegExp) {
      out.push(item);
    } else if (typeof item === 'string') {
      out.push(new RegExp(item));
    } else {
      throw createInvalidArgType(optionName, 'string, RegExp, or Array', item);
    }
  }
  return out;
}

function discoverTestFiles(
  fsObj: Record<string, unknown>,
  baseDir: string,
  globPatterns: ReadonlyArray<string>,
): string[] {
  const readdirSync = fsObj.readdirSync;
  const statSync = fsObj.statSync;
  if (typeof readdirSync !== 'function') return [];

  const matchers = globPatterns.map((p) => new Matcher(p));
  const discovered: string[] = [];

  const walk = (absDir: string, relDir: string): void => {
    let entries: unknown;
    try {
      entries = readdirSync.call(fsObj, absDir, { withFileTypes: true });
    } catch {
      return;
    }
    if (!Array.isArray(entries)) return;

    for (const rawEntry of entries) {
      let entryName: string;
      let isDir = false;
      let isFile = false;

      if (typeof rawEntry === 'string') {
        entryName = rawEntry;
        const childAbs = path.join(absDir, entryName);
        if (typeof statSync === 'function') {
          try {
            const st = statSync.call(fsObj, childAbs);
            if (isRecord(st)) {
              if (typeof st.isDirectory === 'function') isDir = Boolean(st.isDirectory());
              if (typeof st.isFile === 'function') isFile = Boolean(st.isFile());
            }
          } catch {
            continue;
          }
        }
      } else if (isRecord(rawEntry) && typeof rawEntry.name === 'string') {
        entryName = rawEntry.name;
        if (typeof rawEntry.isDirectory === 'function') isDir = Boolean(rawEntry.isDirectory());
        if (typeof rawEntry.isFile === 'function') isFile = Boolean(rawEntry.isFile());
      } else {
        continue;
      }

      if (entryName === 'node_modules' || entryName === '.git' || entryName.startsWith('.')) {
        continue;
      }

      const childAbs = path.join(absDir, entryName);
      const childRel = relDir ? `${relDir}/${entryName}` : entryName;

      if (isDir) {
        walk(childAbs, childRel);
      } else if (isFile) {
        if (matchers.some((m) => m.match(childRel))) {
          discovered.push(childAbs);
        }
      }
    }
  };

  walk(baseDir, '');
  discovered.sort();
  return discovered;
}

function detectEsmTestFile(fsObj: Record<string, unknown>, filePath: string): boolean {
  if (filePath.endsWith('.mjs')) return true;
  if (filePath.endsWith('.cjs')) return false;
  if (!filePath.endsWith('.js')) return false;

  const readFileSync = fsObj.readFileSync;
  if (typeof readFileSync !== 'function') return false;
  let dir = path.dirname(filePath);
  for (;;) {
    const pkgJson = path.join(dir, 'package.json');
    try {
      const raw = readFileSync.call(fsObj, pkgJson, 'utf8');
      const parsed: unknown = JSON.parse(String(raw));
      return isRecord(parsed) && parsed.type === 'module';
    } catch {
      // Keep walking upward until filesystem root or node_modules.
    }
    if (dir === '/' || path.basename(dir) === 'node_modules') {
      return false;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function createRunFunction(
  deps: TestRunnerBuiltinsDeps,
  bridge: RunHarnessBridge,
  snapshotManager: SnapshotManager,
): (options?: unknown) => TestsStreamHandle {
  const esmRunCounts = new Map<string, number>();

  const evictCjsCacheEntry = (filePath: string): void => {
    try {
      const modBuiltin = deps.loadModule('node:module');
      if (!isRecord(modBuiltin) && typeof modBuiltin !== 'function') return;
      if ('_cache' in modBuiltin && isRecord(modBuiltin._cache)) {
        Reflect.deleteProperty(modBuiltin._cache, filePath);
      }
      if ('createRequire' in modBuiltin && typeof modBuiltin.createRequire === 'function') {
        const req = modBuiltin.createRequire(filePath);
        if ((typeof req === 'function' || isRecord(req)) && 'cache' in req && isRecord(req.cache)) {
          Reflect.deleteProperty(req.cache, filePath);
        }
      }
    } catch {
      // Optional in isolated unit stubs without node:module.
    }
  };

  function run(rawOptions?: unknown): TestsStreamHandle {
    if (rawOptions !== undefined && !isRecord(rawOptions)) {
      throw createInvalidArgType('options', 'Object', rawOptions);
    }
    const optsRecord: Record<string, unknown> = isRecord(rawOptions) ? rawOptions : {};

    if (optsRecord.cwd !== undefined && typeof optsRecord.cwd !== 'string') {
      throw createInvalidArgType('options.cwd', 'string', optsRecord.cwd);
    }
    if (optsRecord.files !== undefined && !Array.isArray(optsRecord.files)) {
      throw createInvalidArgType('options.files', 'Array', optsRecord.files);
    }
    if (optsRecord.globPatterns !== undefined && !Array.isArray(optsRecord.globPatterns)) {
      throw createInvalidArgType('options.globPatterns', 'Array', optsRecord.globPatterns);
    }
    if (optsRecord.files !== undefined && optsRecord.globPatterns !== undefined) {
      throw createInvalidArgValue(
        'options.globPatterns',
        optsRecord.globPatterns,
        "cannot be used alongside 'options.files'",
      );
    }
    if (optsRecord.setup !== undefined && typeof optsRecord.setup !== 'function') {
      throw createInvalidArgType('options.setup', 'Function', optsRecord.setup);
    }
    if (optsRecord.signal !== undefined && !(optsRecord.signal instanceof AbortSignal)) {
      throw createInvalidArgType('options.signal', 'AbortSignal', optsRecord.signal);
    }
    if (
      optsRecord.timeout !== undefined &&
      (typeof optsRecord.timeout !== 'number' || optsRecord.timeout < 0)
    ) {
      throw createInvalidArgType('options.timeout', 'non-negative number', optsRecord.timeout);
    }

    let shardIndex = 1;
    let shardTotal = 1;
    if (optsRecord.shard !== undefined) {
      if (!isRecord(optsRecord.shard)) {
        throw createInvalidArgType('options.shard', 'Object', optsRecord.shard);
      }
      if (
        typeof optsRecord.shard.total !== 'number' ||
        !Number.isInteger(optsRecord.shard.total) ||
        optsRecord.shard.total < 1
      ) {
        throw createInvalidArgValue(
          'options.shard.total',
          optsRecord.shard.total,
          'must be a positive integer',
        );
      }
      if (
        typeof optsRecord.shard.index !== 'number' ||
        !Number.isInteger(optsRecord.shard.index) ||
        optsRecord.shard.index < 1 ||
        optsRecord.shard.index > optsRecord.shard.total
      ) {
        throw createInvalidArgValue(
          'options.shard.index',
          optsRecord.shard.index,
          `must be an integer between 1 and ${optsRecord.shard.total}`,
        );
      }
      shardIndex = optsRecord.shard.index;
      shardTotal = optsRecord.shard.total;
    }

    const namePatterns = normalizePatternList(
      'options.testNamePatterns',
      optsRecord.testNamePatterns,
    );
    const skipPatterns = normalizePatternList(
      'options.testSkipPatterns',
      optsRecord.testSkipPatterns,
    );
    const cwdOption = typeof optsRecord.cwd === 'string' ? optsRecord.cwd : undefined;
    const baseDir = cwdOption ? path.resolve(deps.cwd(), cwdOption) : deps.cwd();

    let resolvedFiles: string[];
    if (Array.isArray(optsRecord.files)) {
      resolvedFiles = optsRecord.files.map((f, idx) => {
        if (typeof f !== 'string') {
          throw createInvalidArgType(`options.files[${idx}]`, 'string', f);
        }
        return path.resolve(baseDir, f);
      });
    } else {
      const patterns = Array.isArray(optsRecord.globPatterns)
        ? optsRecord.globPatterns.map((p, idx) => {
            if (typeof p !== 'string') {
              throw createInvalidArgType(`options.globPatterns[${idx}]`, 'string', p);
            }
            return p;
          })
        : DEFAULT_TEST_GLOBS;
      resolvedFiles = discoverTestFiles(deps.fs, baseDir, patterns);
    }

    if (shardTotal > 1) {
      resolvedFiles = resolvedFiles.filter((_file, idx) => idx % shardTotal === shardIndex - 1);
    }

    const onlyOption = optsRecord.only === undefined ? undefined : Boolean(optsRecord.only);
    const timeoutOption = typeof optsRecord.timeout === 'number' ? optsRecord.timeout : undefined;
    const signalOption = optsRecord.signal instanceof AbortSignal ? optsRecord.signal : undefined;
    const updateSnapshotsOption =
      optsRecord.updateSnapshots === undefined ? undefined : Boolean(optsRecord.updateSnapshots);
    const watchOption = Boolean(optsRecord.watch);
    const setupFn =
      typeof optsRecord.setup === 'function'
        ? // Invariant: narrowed optsRecord.setup to a callable function above.
          (optsRecord.setup as (root: TestsStreamHandle) => unknown)
        : undefined;

    const stream = createTestsStream(deps);
    deps.retain();

    deps.setImmediate(() => {
      void (async () => {
        const runStartNs = deps.hrtimeNs();
        const aggregateCounts: TestSummaryCounts = {
          tests: 0,
          suites: 0,
          pass: 0,
          fail: 0,
          cancelled: 0,
          skipped: 0,
          todo: 0,
          topLevel: 0,
        };
        let anyFailed = false;

        if (updateSnapshotsOption !== undefined) {
          snapshotManager.setUpdateOverride(updateSnapshotsOption);
        }
        snapshotManager.resetRunCounters();

        try {
          if (setupFn) {
            await setupFn(stream);
          }

          for (let i = 0; i < resolvedFiles.length; i += 1) {
            if (signalOption?.aborted) {
              anyFailed = true;
              break;
            }
            const filePath = resolvedFiles[i];
            const fileStartNs = deps.hrtimeNs();

            try {
              const { summary } = await bridge.runWithFileHarness(
                {
                  filePath,
                  onlyMode: onlyOption,
                  timeout: timeoutOption,
                  signal: signalOption,
                  testNamePatterns: namePatterns,
                  testSkipPatterns: skipPatterns,
                  updateSnapshots: updateSnapshotsOption,
                  sink: (ev) => stream.emitEvent(ev),
                },
                async () => {
                  if (detectEsmTestFile(deps.fs, filePath)) {
                    const prevCount = esmRunCounts.get(filePath) ?? 0;
                    esmRunCounts.set(filePath, prevCount + 1);
                    const specifier =
                      prevCount === 0 ? filePath : `${filePath}?testRun=${prevCount}`;
                    await deps.importModule(specifier);
                  } else {
                    evictCjsCacheEntry(filePath);
                    deps.loadModule(filePath);
                  }
                },
              );

              aggregateCounts.tests += summary.counts.tests;
              aggregateCounts.suites += summary.counts.suites;
              aggregateCounts.pass += summary.counts.pass;
              aggregateCounts.fail += summary.counts.fail;
              aggregateCounts.cancelled += summary.counts.cancelled;
              aggregateCounts.skipped += summary.counts.skipped;
              aggregateCounts.todo += summary.counts.todo;
              aggregateCounts.topLevel += summary.counts.topLevel;
              if (!summary.success) {
                anyFailed = true;
              }
              stream.emitEvent({
                type: 'test:summary',
                data: {
                  success: summary.success,
                  counts: summary.counts,
                  duration_ms: summary.durationMs,
                  file: filePath,
                },
              });
            } catch (fileErr) {
              anyFailed = true;
              aggregateCounts.tests += 1;
              aggregateCounts.fail += 1;
              aggregateCounts.topLevel += 1;
              const wrapped = createTestFailureError(fileErr, 'testCodeFailure');
              const fileDurationMs = Number(deps.hrtimeNs() - fileStartNs) / 1_000_000;
              stream.emitEvent({
                type: 'test:start',
                data: { nesting: 0, name: filePath, file: filePath },
              });
              stream.emitEvent({
                type: 'test:fail',
                data: {
                  name: filePath,
                  nesting: 0,
                  testNumber: i + 1,
                  file: filePath,
                  details: {
                    duration_ms: fileDurationMs,
                    type: 'test',
                    error: wrapped,
                  },
                },
              });
            }
          }

          const totalDurationMs = Number(deps.hrtimeNs() - runStartNs) / 1_000_000;
          stream.emitEvent({
            type: 'test:plan',
            data: {
              nesting: 0,
              count: aggregateCounts.topLevel,
            },
          });
          for (const message of formatSummaryDiagnosticMessages(aggregateCounts, totalDurationMs)) {
            stream.emitEvent({
              type: 'test:diagnostic',
              data: {
                nesting: 0,
                message,
                level: 'info',
              },
            });
          }
          stream.emitEvent({
            type: 'test:summary',
            data: {
              success: !anyFailed && aggregateCounts.fail === 0 && aggregateCounts.cancelled === 0,
              counts: aggregateCounts,
              duration_ms: totalDurationMs,
            },
          });
          if (watchOption) {
            stream.emitEvent({
              type: 'test:watch:drained',
              data: undefined,
            });
          }
        } finally {
          if (updateSnapshotsOption !== undefined) {
            snapshotManager.setUpdateOverride(undefined);
          }
          stream.endStream();
          deps.release();
        }
      })();
    });

    return stream;
  }

  return run;
}
