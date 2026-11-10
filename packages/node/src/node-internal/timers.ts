// Browser-safe `timers` bridge for upstream Node `lib/` modules (`internal/readline/emitKeypressEvents`).
// Delegates dynamically to the active guest process timers so escape-sequence timeouts
// participate in guest process lifetime and experimental AsyncLocalStorage propagation.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

type SetTimeoutLike = (
  callback: (...args: unknown[]) => void,
  delay?: number,
  ...args: unknown[]
) => unknown;
type ClearTimeoutLike = (handle: unknown) => void;

let activeSetTimeout: SetTimeoutLike = (callback, delay, ...args) =>
  globalThis.setTimeout(callback, delay, ...args);
let activeClearTimeout: ClearTimeoutLike = (handle) => {
  // Invariant: fallback clears handles produced by `globalThis.setTimeout`.
  globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
};

export function setGuestTimers(
  setTimeoutFn: SetTimeoutLike,
  clearTimeoutFn: ClearTimeoutLike,
): void {
  activeSetTimeout = setTimeoutFn;
  activeClearTimeout = clearTimeoutFn;
}

export function setTimeout(
  callback: (...args: unknown[]) => void,
  delay?: number,
  ...args: unknown[]
): unknown {
  return activeSetTimeout(callback, delay, ...args);
}

export function clearTimeout(handle: unknown): void {
  activeClearTimeout(handle);
}
