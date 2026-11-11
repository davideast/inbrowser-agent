import type { EventEmitter } from 'events';
import { createPerfHooks } from '../perf-hooks';

export interface PerfHooksBuiltinDeps {
  setImmediate: (callback: () => void) => unknown;
  hrtimeNs: () => bigint;
  setTimeout?: (fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => unknown;
  clearTimeout?: (timer: unknown) => void;
  setInterval?: (fn: (...args: unknown[]) => void, delay?: unknown, ...args: unknown[]) => unknown;
  clearInterval?: (timer: unknown) => void;
  process?: EventEmitter;
  getLoopExit?: () => number;
}

export function createPerfHooksBuiltin({
  setImmediate,
  hrtimeNs,
  setInterval,
  clearInterval,
  getLoopExit,
}: PerfHooksBuiltinDeps) {
  return createPerfHooks(setImmediate, { hrtimeNs, setInterval, clearInterval, getLoopExit });
}
