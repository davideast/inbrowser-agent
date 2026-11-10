// `process.finalization`, after Node 22.18's lib/internal/process/finalization.js
// (itself the on-exit-leak-free module): callbacks run from the process's own
// `exit` and `beforeExit` events for registered objects that are still alive. The
// engine's WeakRef and FinalizationRegistry drop an entry once its object is
// collected, so registration does not keep the object alive.
import { invalidArgType } from './process-warning';

type Event = 'exit' | 'beforeExit';
type Callback = (obj: object, event: Event) => void;
type Ref = WeakRef<object> & { fn: unknown };

/** The part of the guest `process` object finalization uses. */
export interface FinalizationProcess {
  on(name: string, listener: () => void): unknown;
  removeListener(name: string, listener: () => void): unknown;
  emitWarning?: unknown;
}

export function createFinalization(process: FinalizationProcess) {
  let registry: FinalizationRegistry<Ref> | null = null;
  const refs: Record<Event, Ref[]> = { exit: [], beforeExit: [] };
  const functions: Record<Event, () => void> = {
    exit: () => callRefsToFree('exit'),
    beforeExit: () => callRefsToFree('beforeExit'),
  };
  // Node warns once per feature, through the live process.emitWarning.
  const warned = new Set<string>();
  const experimental = (feature: string) => {
    if (warned.has(feature)) return;
    warned.add(feature);
    const emitWarning = process.emitWarning;
    if (typeof emitWarning === 'function')
      Reflect.apply(emitWarning, process, [
        `${feature} is an experimental feature and might change at any time`,
        'ExperimentalWarning',
      ]);
  };

  function install(event: Event) {
    if (refs[event].length > 0) return;
    process.on(event, functions[event]);
  }

  function uninstall(event: Event) {
    if (refs[event].length > 0) return;
    process.removeListener(event, functions[event]);
    if (refs.exit.length === 0 && refs.beforeExit.length === 0) registry = null;
  }

  function callRefsToFree(event: Event) {
    for (const ref of refs[event]) {
      const obj = ref.deref();
      // Node does not validate the callback: a non-callable one throws here, from
      // the listener, with the engine's "fn is not a function", as it does natively.
      const fn = ref.fn as Callback;
      // Not called for an object the engine has collected.
      if (obj !== undefined) fn(obj, event);
    }
    refs[event] = [];
  }

  // Runs when a registered object is collected. Node's splice arguments are kept
  // as they are, including its removal span.
  function clear(ref: Ref) {
    for (const event of ['exit', 'beforeExit'] as const) {
      const index = refs[event].indexOf(ref);
      refs[event].splice(index, index + 1);
      uninstall(event);
    }
  }

  function validate(obj: unknown): asserts obj is object {
    if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function'))
      throw invalidArgType('obj', 'of type object', obj);
  }

  function register(event: Event, obj: object, fn: unknown) {
    install(event);
    const ref: Ref = Object.assign(new WeakRef(obj), { fn });
    registry ||= new FinalizationRegistry(clear);
    registry.register(obj, ref);
    refs[event].push(ref);
  }

  return {
    register(obj: unknown, fn: unknown): void {
      experimental('process.finalization.register');
      validate(obj);
      register('exit', obj, fn);
    },
    registerBeforeExit(obj: unknown, fn: unknown): void {
      experimental('process.finalization.registerBeforeExit');
      validate(obj);
      register('beforeExit', obj, fn);
    },
    unregister(obj: unknown): void {
      experimental('process.finalization.unregister');
      if (!registry) return;
      // The engine validates the token, as it does natively: a primitive is a TypeError.
      registry.unregister(obj as WeakKey);
      for (const event of ['exit', 'beforeExit'] as const) {
        refs[event] = refs[event].filter((ref) => {
          const registered = ref.deref();
          return registered && registered !== obj;
        });
        uninstall(event);
      }
    },
  };
}
