import path from 'path-browserify';
import type { TestRunnerBuiltinsDeps } from '../builtins/test-runner';
import {
  createInvalidArgType,
  createInvalidState,
  getProcessArgv,
  getProcessExecArgv,
  inspectWithDeps,
  isRecord,
} from './types';

export type SnapshotSerializer = (value: unknown) => unknown;
export type SnapshotPathResolver = (testPath: string | undefined) => string;

function escapeTemplateLiteral(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function unescapeTemplateSlice(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      i += 1;
      if (next === '`' || next === '\\' || next === '$') {
        out += next;
      } else if (next === 'n') {
        out += '\n';
      } else if (next === 'r') {
        out += '\r';
      } else if (next === 't') {
        out += '\t';
      } else {
        out += next;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function parseSnapshotSourceFallback(source: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let idx = 0;
  const readTemplate = (): string | undefined => {
    if (source[idx] !== '`') return undefined;
    idx += 1;
    const start = idx;
    let raw = '';
    while (idx < source.length) {
      const ch = source[idx];
      if (ch === '\\') {
        idx += 2;
        continue;
      }
      if (ch === '`') {
        raw += source.slice(start, idx);
        idx += 1;
        return unescapeTemplateSlice(raw);
      }
      idx += 1;
    }
    return undefined;
  };

  while (idx < source.length) {
    const marker = source.indexOf('exports[', idx);
    if (marker === -1) break;
    idx = marker + 'exports['.length;
    while (idx < source.length && /\s/.test(source[idx])) idx += 1;
    const key = readTemplate();
    if (key === undefined) break;
    while (idx < source.length && /\s/.test(source[idx])) idx += 1;
    if (source[idx] !== ']') continue;
    idx += 1;
    while (idx < source.length && /\s/.test(source[idx])) idx += 1;
    if (source[idx] !== '=') continue;
    idx += 1;
    while (idx < source.length && /\s/.test(source[idx])) idx += 1;
    const val = readTemplate();
    if (val === undefined) break;
    result[key] = val;
  }
  return result;
}

function formatSnapshotEntries(entries: Record<string, string>): string {
  const blocks: string[] = [];
  for (const key of Object.keys(entries)) {
    const val = entries[key];
    blocks.push(
      `exports[\`${escapeTemplateLiteral(key)}\`] = \`${escapeTemplateLiteral(val)}\`;\n`,
    );
  }
  return blocks.join('\n');
}

export class SnapshotManager {
  readonly #deps: TestRunnerBuiltinsDeps;
  #defaultSerializers: SnapshotSerializer[];
  #resolveSnapshotPath: SnapshotPathResolver;
  #updateOverride: boolean | undefined;
  readonly #counters = new Map<string, number>();
  readonly #loadedSnapshots = new Map<string, Record<string, string>>();

  constructor(deps: TestRunnerBuiltinsDeps) {
    this.#deps = deps;
    this.#defaultSerializers = [
      (value: unknown): string => {
        try {
          const json = JSON.stringify(value, null, 2);
          if (typeof json === 'string') return json;
        } catch {
          // Fall through to util.inspect.
        }
        return inspectWithDeps(deps, value);
      },
    ];
    this.#resolveSnapshotPath = (testPath: string | undefined): string => {
      if (typeof testPath !== 'string' || testPath.length === 0) {
        throw createInvalidState(
          'Cannot resolve snapshot path without a test file path; configure snapshot.setResolveSnapshotPath()',
        );
      }
      return `${testPath}.snapshot`;
    };
  }

  setUpdateOverride(update: boolean | undefined): void {
    this.#updateOverride = update;
  }

  resetRunCounters(): void {
    this.#counters.clear();
    this.#loadedSnapshots.clear();
  }

  setDefaultSnapshotSerializers(serializers: ReadonlyArray<SnapshotSerializer>): void {
    if (!Array.isArray(serializers)) {
      throw createInvalidArgType('serializers', 'Array', serializers);
    }
    for (let i = 0; i < serializers.length; i += 1) {
      if (typeof serializers[i] !== 'function') {
        throw createInvalidArgType(`serializers[${i}]`, 'Function', serializers[i]);
      }
    }
    this.#defaultSerializers = serializers.slice();
  }

  setResolveSnapshotPath(fn: SnapshotPathResolver): void {
    if (typeof fn !== 'function') {
      throw createInvalidArgType('fn', 'Function', fn);
    }
    this.#resolveSnapshotPath = fn;
  }

  assertSnapshot(
    context: { fullName: string; filePath: string | undefined },
    value: unknown,
    options?: { serializers?: ReadonlyArray<SnapshotSerializer> },
  ): void {
    const serialized = this.#serialize(value, options);
    const wrappedActual = `\n${serialized}\n`;
    const snapshotFile = this.#resolvePath(context.filePath);
    const counterKey = `${snapshotFile}::${context.fullName}`;
    const count = (this.#counters.get(counterKey) ?? 0) + 1;
    this.#counters.set(counterKey, count);
    const entryKey = `${context.fullName} ${count}`;

    if (this.#isUpdateMode()) {
      const table = this.#readSnapshotTable(snapshotFile, false);
      table[entryKey] = wrappedActual;
      this.#writeFile(snapshotFile, formatSnapshotEntries(table));
      return;
    }

    const table = this.#readSnapshotTable(snapshotFile, true);
    if (!(entryKey in table)) {
      throw this.#createAssertionFailure(
        wrappedActual,
        undefined,
        `Missing snapshot '${entryKey}' in '${snapshotFile}'`,
      );
    }
    const expected = table[entryKey];
    if (wrappedActual !== expected) {
      this.#assertStrictEqual(wrappedActual, expected);
    }
  }

  assertFileSnapshot(
    value: unknown,
    snapshotPath: string,
    options?: { serializers?: ReadonlyArray<SnapshotSerializer> },
  ): void {
    if (typeof snapshotPath !== 'string' || snapshotPath.length === 0) {
      throw createInvalidArgType('path', 'string', snapshotPath);
    }
    const resolvedPath = path.resolve(this.#deps.cwd(), snapshotPath);
    const serialized = this.#serialize(value, options);

    if (this.#isUpdateMode()) {
      this.#writeFile(resolvedPath, serialized);
      return;
    }

    const existing = this.#readFile(resolvedPath);
    if (existing === undefined) {
      throw this.#createAssertionFailure(
        serialized,
        undefined,
        `Snapshot file '${resolvedPath}' does not exist`,
      );
    }
    if (serialized !== existing) {
      this.#assertStrictEqual(serialized, existing);
    }
  }

  createNamespace(): Record<string, unknown> {
    const applySerializers = (serializers: ReadonlyArray<SnapshotSerializer>): void => {
      this.setDefaultSnapshotSerializers(serializers);
    };
    const applyResolver = (fn: SnapshotPathResolver): void => {
      this.setResolveSnapshotPath(fn);
    };
    function setDefaultSnapshotSerializers(serializers: ReadonlyArray<SnapshotSerializer>): void {
      applySerializers(serializers);
    }
    function setResolveSnapshotPath(fn: SnapshotPathResolver): void {
      applyResolver(fn);
    }
    const ns: Record<string, unknown> = Object.create(null);
    Object.defineProperties(ns, {
      setDefaultSnapshotSerializers: {
        value: setDefaultSnapshotSerializers,
        writable: true,
        enumerable: true,
        configurable: true,
      },
      setResolveSnapshotPath: {
        value: setResolveSnapshotPath,
        writable: true,
        enumerable: true,
        configurable: true,
      },
    });
    return ns;
  }

  #isUpdateMode(): boolean {
    if (this.#updateOverride !== undefined) return this.#updateOverride;
    return (
      getProcessExecArgv(this.#deps).includes('--test-update-snapshots') ||
      getProcessArgv(this.#deps).includes('--test-update-snapshots')
    );
  }

  #resolvePath(testPath: string | undefined): string {
    const resolved = this.#resolveSnapshotPath(testPath);
    if (typeof resolved !== 'string' || resolved.length === 0) {
      throw createInvalidArgType('snapshotPath', 'non-empty string', resolved);
    }
    return path.resolve(this.#deps.cwd(), resolved);
  }

  #serialize(
    value: unknown,
    options?: { serializers?: ReadonlyArray<SnapshotSerializer> },
  ): string {
    let serializers: ReadonlyArray<SnapshotSerializer> = this.#defaultSerializers;
    if (options !== undefined) {
      if (!isRecord(options)) {
        throw createInvalidArgType('options', 'Object', options);
      }
      if (options.serializers !== undefined) {
        if (!Array.isArray(options.serializers)) {
          throw createInvalidArgType('options.serializers', 'Array', options.serializers);
        }
        for (let i = 0; i < options.serializers.length; i += 1) {
          if (typeof options.serializers[i] !== 'function') {
            throw createInvalidArgType(
              `options.serializers[${i}]`,
              'Function',
              options.serializers[i],
            );
          }
        }
        serializers = options.serializers;
      }
    }
    let current: unknown = value;
    for (const fn of serializers) {
      current = fn(current);
    }
    if (typeof current !== 'string') {
      const err = new TypeError(
        `The serialized snapshot value must be of type string. Received ${typeof current}`,
      );
      throw Object.assign(err, { code: 'ERR_INVALID_RETURN_VALUE' });
    }
    return current;
  }

  #readSnapshotTable(snapshotFile: string, mustExist: boolean): Record<string, string> {
    const cached = this.#loadedSnapshots.get(snapshotFile);
    if (cached) return cached;

    const raw = this.#readFile(snapshotFile);
    if (raw === undefined) {
      if (mustExist) {
        throw this.#createAssertionFailure(
          '',
          undefined,
          `Snapshot file '${snapshotFile}' was not found`,
        );
      }
      const empty: Record<string, string> = Object.create(null);
      this.#loadedSnapshots.set(snapshotFile, empty);
      return empty;
    }

    let parsed: Record<string, string> | undefined;
    try {
      const vmMod = this.#deps.loadModule('node:vm');
      if (isRecord(vmMod) && typeof vmMod.runInNewContext === 'function') {
        const exportsBag: Record<string, unknown> = Object.create(null);
        vmMod.runInNewContext(raw, { exports: exportsBag });
        const table: Record<string, string> = Object.create(null);
        for (const [k, v] of Object.entries(exportsBag)) {
          table[k] = String(v);
        }
        parsed = table;
      }
    } catch {
      parsed = undefined;
    }

    parsed ??= parseSnapshotSourceFallback(raw);
    this.#loadedSnapshots.set(snapshotFile, parsed);
    return parsed;
  }

  #readFile(filePath: string): string | undefined {
    const readFileSync = this.#deps.fs.readFileSync;
    if (typeof readFileSync !== 'function') return undefined;
    try {
      const out = readFileSync.call(this.#deps.fs, filePath, 'utf8');
      return typeof out === 'string' ? out : String(out);
    } catch (err) {
      if (isRecord(err) && err.code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
  }

  #writeFile(filePath: string, content: string): void {
    const mkdirSync = this.#deps.fs.mkdirSync;
    if (typeof mkdirSync === 'function') {
      mkdirSync.call(this.#deps.fs, path.dirname(filePath), { recursive: true });
    }
    const writeFileSync = this.#deps.fs.writeFileSync;
    if (typeof writeFileSync !== 'function') {
      throw createInvalidState('Filesystem does not support writeFileSync for snapshots');
    }
    writeFileSync.call(this.#deps.fs, filePath, content, 'utf8');
  }

  #assertStrictEqual(actual: string, expected: string): void {
    const assertMod = this.#deps.loadModule('node:assert/strict');
    if (
      (typeof assertMod === 'function' || isRecord(assertMod)) &&
      'strictEqual' in assertMod &&
      typeof assertMod.strictEqual === 'function'
    ) {
      assertMod.strictEqual(actual, expected);
    }
    throw this.#createAssertionFailure(actual, expected, 'Snapshot values do not match');
  }

  #createAssertionFailure(actual: unknown, expected: unknown, message: string): Error {
    return Object.assign(new Error(message), {
      code: 'ERR_ASSERTION',
      actual,
      expected,
      operator: 'snapshot',
    });
  }
}
