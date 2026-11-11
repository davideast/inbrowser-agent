// Dynamic reference to the active guest `process` inside the process Worker.
// Bundled modules would otherwise receive esbuild's injected `process/browser`
// shim instead of the live guest `process` instance.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

export interface GuestProcessLike {
  env: Record<string, unknown>;
  platform?: string;
  argv?: string[];
  execArgv?: string[];
  noDeprecation?: unknown;
  throwDeprecation?: unknown;
  traceDeprecation?: unknown;
  _exiting?: boolean;
  cwd?: () => string;
  stdout?: { isTTY?: boolean; columns?: number; getColorDepth?: () => number };
  stderr?: { isTTY?: boolean; columns?: number; getColorDepth?: () => number };
  emitWarning?: (
    warning: string | Error,
    type?: string | Record<string, unknown>,
    code?: string,
    ctor?: (...args: never[]) => unknown,
  ) => void;
  nextTick?: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void;
  getBuiltinModule?: (id: string) => unknown;
  [key: PropertyKey]: unknown;
}

const fallbackProcess: GuestProcessLike = {
  env: {},
  platform: 'linux',
  argv: ['/bin/node'],
  execArgv: [],
  stdout: { isTTY: false },
  stderr: { isTTY: false },
  nextTick: (callback, ...args) => {
    globalThis.queueMicrotask(() => callback(...args));
  },
};

export function setFallbackNextTick(
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void,
): void {
  fallbackProcess.nextTick = nextTick;
}

function isGuestProcessLike(value: unknown): value is GuestProcessLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'env') === 'object' &&
    Reflect.get(value, 'env') !== null
  );
}

let explicitProcess: GuestProcessLike | undefined;
const listeners: Array<(proc: GuestProcessLike) => void> = [];

export function setGuestProcess(proc: { env: Record<string, unknown> }): void {
  // Invariant: callers pass the guest `process` object (carrying `env: Record<string, unknown>` and optional Node process members).
  const typed = proc as GuestProcessLike;
  explicitProcess = typed;
  for (const listener of listeners) listener(typed);
  if (!Object.prototype.hasOwnProperty.call(typed, 'getBuiltinModule')) {
    Object.defineProperty(typed, 'getBuiltinModule', {
      configurable: true,
      enumerable: false,
      get() {
        return undefined;
      },
      set(fn: unknown) {
        Object.defineProperty(typed, 'getBuiltinModule', {
          value: fn,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        for (const listener of listeners) listener(typed);
      },
    });
  }
}

export function onGuestProcessChange(listener: (proc: GuestProcessLike) => void): void {
  listeners.push(listener);
}

export function activeProcess(): GuestProcessLike {
  if (explicitProcess) return explicitProcess;
  const globalProc: unknown = Reflect.get(globalThis, 'process');
  if (isGuestProcessLike(globalProc) && typeof globalProc.emitWarning === 'function') {
    return globalProc;
  }
  return fallbackProcess;
}

export const guestProcess: GuestProcessLike = new Proxy(fallbackProcess, {
  get(_target, prop) {
    const proc = activeProcess();
    return Reflect.get(proc, prop, proc);
  },
  set(_target, prop, value) {
    const proc = activeProcess();
    return Reflect.set(proc, prop, value, proc);
  },
  has(_target, prop) {
    return Reflect.has(activeProcess(), prop);
  },
  ownKeys() {
    return Reflect.ownKeys(activeProcess());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(activeProcess(), prop);
  },
});
