import type { EventEmitter } from 'events';
import { createTestModuleController } from '../test-runner/harness';
import { createReportersModule } from '../test-runner/reporters';

export interface TestRunnerBuiltinsDeps {
  process: EventEmitter;
  fs: Record<string, unknown>;
  cwd: () => string;
  setTimeout: (fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => unknown;
  clearTimeout: (timer: unknown) => void;
  setInterval: (fn: (...args: unknown[]) => void, delay?: unknown, ...args: unknown[]) => unknown;
  clearInterval: (timer: unknown) => void;
  setImmediate: (fn: (...args: unknown[]) => void, ...args: unknown[]) => unknown;
  clearImmediate: (timer: unknown) => void;
  hrtimeNs: () => bigint;
  retain: () => void;
  release: () => void;
  loadModule: (id: string, parent?: string) => unknown;
  importModule: (specifier: string, parent?: string) => Promise<unknown>;
  events: unknown;
  stream: unknown;
  util: Record<string, unknown>;
  asyncHooks: Record<string, unknown>;
}

export function registerTestRunnerBuiltins(
  target: Record<string, unknown>,
  deps: TestRunnerBuiltinsDeps,
): void {
  let cachedTestExport: unknown;
  let cachedReportersExport: Record<string, unknown> | undefined;

  Object.defineProperty(target, 'test', {
    enumerable: true,
    configurable: true,
    get() {
      cachedTestExport ??= createTestModuleController(deps, target).testExport;
      return cachedTestExport;
    },
  });

  Object.defineProperty(target, 'test/reporters', {
    enumerable: true,
    configurable: true,
    get() {
      cachedReportersExport ??= createReportersModule(deps);
      return cachedReportersExport;
    },
  });
}
