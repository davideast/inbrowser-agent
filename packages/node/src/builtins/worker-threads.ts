import type { EventEmitter } from 'events';
import { createWorkerThreads } from '../worker-threads';

export interface WorkerThreadsContext {
  port: MessagePort;
  data: unknown;
  id: number;
}

export interface WorkerThreadsBuiltinDeps {
  defaults: () => { cwd: string; env: Record<string, unknown>; pid: number; execArgv: string[] };
  retain: () => void;
  release: () => void;
  output: (stream: 'stdout' | 'stderr', bytes: Uint8Array) => void;
  context?: WorkerThreadsContext;
  process?: EventEmitter;
  events?: unknown;
  stream?: unknown;
  fs?: Record<string, unknown>;
  setTimeout?: (fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => unknown;
  clearTimeout?: (timer: unknown) => void;
  setImmediate?: (fn: (...args: unknown[]) => void, ...args: unknown[]) => unknown;
}

export function createWorkerThreadsBuiltin({
  defaults,
  retain,
  release,
  output,
  context,
}: WorkerThreadsBuiltinDeps) {
  return createWorkerThreads(defaults, retain, release, output, context);
}
