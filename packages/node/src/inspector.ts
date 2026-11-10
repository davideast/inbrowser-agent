import { EventEmitter } from 'events';
import { fault, record } from './protocol';

// `inspector` for a runtime with no V8 inspector endpoint. While no inspector is
// active the pinned Node 22.18.0 documents, and this module reproduces:
//   - `url()` returns undefined (inspector.md, "inspector.url()": "or `undefined`
//     if there is none", with `node -p 'inspector.url()'` printing undefined);
//   - `close()` closes "all remaining connections" and deactivates the inspector
//     (inspector.md, "inspector.close()"); with none open it is a no-op;
//   - `waitForDebugger()` throws ERR_INSPECTOR_NOT_ACTIVE (inspector.md,
//     "inspector.waitForDebugger()": "Blocks until a client ... has connected");
//   - a Session that was never connected rejects `post()` with
//     ERR_INSPECTOR_NOT_CONNECTED and ignores `disconnect()`.
// Anything that would start or reach a debugger (`open`, `Session#connect`,
// `Session#connectToMainThread` from a worker thread) fails with ENOSYS: no
// Worker can serve the inspector protocol, and claiming otherwise is worse than
// failing. `inspector.console` and `inspector.Network` are not provided.

function describe(value: unknown): string {
  if (value === undefined || value === null) return String(value);
  if (typeof value === 'function') return `function ${value.name}`;
  if (typeof value === 'object') {
    const name: unknown = Object.getPrototypeOf(value)?.constructor?.name;
    return typeof name === 'string' && name ? `an instance of ${name}` : 'an object';
  }
  return `type ${typeof value} (${typeof value === 'string' ? `'${value}'` : String(value)})`;
}

function invalidType(name: string, expected: string, value: unknown): TypeError {
  return Object.assign(
    new TypeError(
      `The "${name}" argument must be of type ${expected}. Received ${describe(value)}`,
    ),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
}

type PostCallback = (error: Error | null, result?: unknown) => void;

export function createInspector(workerThread: boolean) {
  const unsupported = (what: string): never => {
    throw fault('ENOSYS', `${what} requires a V8 inspector, which a browser Worker cannot provide`);
  };
  class Session extends EventEmitter {
    connect(): never {
      return unsupported('inspector.Session#connect');
    }
    connectToMainThread(): never {
      // Verified natively on the main thread: it is not a worker.
      if (!workerThread) throw fault('ERR_INSPECTOR_NOT_WORKER', 'Current thread is not a worker');
      return unsupported('inspector.Session#connectToMainThread');
    }
    post(method: unknown, params?: unknown, callback?: unknown): unknown {
      if (typeof method !== 'string') throw invalidType('method', 'string', method);
      if (!callback && typeof params === 'function') {
        callback = params;
        params = null;
      }
      if (params && !record(params)) throw invalidType('params', 'object', params);
      if (callback && typeof callback !== 'function')
        throw invalidType('callback', 'function', callback);
      // A Session can never connect here, so it is always in Node's idle state.
      throw fault('ERR_INSPECTOR_NOT_CONNECTED', 'Session is not connected');
    }
    disconnect(): void {
      // Nothing can be connected, which Node treats as a no-op.
    }
  }
  const members = {
    open: (): never => unsupported('inspector.open'),
    close: (): void => undefined,
    url: (): undefined => undefined,
    waitForDebugger: (): never => {
      throw fault('ERR_INSPECTOR_NOT_ACTIVE', 'Inspector is not active');
    },
    Session,
  };
  // `inspector/promises` shares the functions and wraps `post` in a promise. The
  // wrapper forwards its arguments plus a callback exactly as Node's promisify
  // does, so argument errors reject instead of throwing.
  class PromisesSession extends Session {
    override post(...args: unknown[]): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const settle: PostCallback = (error, result) => (error ? reject(error) : resolve(result));
        // Node's argument errors print the callback's name, which is empty there.
        Object.defineProperty(settle, 'name', { value: '' });
        Reflect.apply(Session.prototype.post, this, [...args, settle]);
      });
    }
  }
  return { inspector: members, promises: { ...members, Session: PromisesSession } };
}
