// A process Worker is one realm with at most one async context. Modules that
// own a host callback entry point (a MessagePort handler, a completion callback
// held across a host round trip) bind it here instead of each taking the context
// as a parameter. Outside experimental mode `captured` returns its argument
// itself, so the default runtime calls exactly the functions it always did.

type Capture = (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown;

let capture: Capture | undefined;

/** Installed once by the process bootstrap, before any guest code runs. */
export function installCapture(next: Capture): void {
  capture = next;
}

/** Binds `fn` to the async context that is current at this call. */
export function captured<Fn extends (...args: never[]) => unknown>(fn: Fn): Fn {
  if (!capture) return fn;
  // `capture` forwards the receiver and every argument unchanged and returns the
  // callee's result, so the wrapper has the same call signature as `fn`.
  return capture(fn as unknown as (...args: unknown[]) => unknown) as unknown as Fn;
}
