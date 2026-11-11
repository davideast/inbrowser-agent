import readlineModule from 'internal/nodelib/readline';
import * as readlineInterfaceInternal from 'internal/nodelib/readline/interface';
import readlinePromisesModule from 'internal/nodelib/readline/promises';
import { setGuestProcess } from '../node-internal/process-ref';
import { setGuestTimers } from '../node-internal/timers';
import { preserveFunctionNames } from '../node-internal/util';
import { resourceLimits } from '../resource-policy';
import { fault, record } from '../value-guards';

type AnyCallable = (...args: unknown[]) => unknown;
type ReadlineBatchThis = InstanceType<typeof readlinePromisesModule.Readline>;

let initialized = false;

function guardDumbTtyWrite(instance: Record<string | symbol, unknown>): void {
  if (!Object.prototype.hasOwnProperty.call(instance, '_ttyWrite')) return;
  const ownTtyWrite = instance._ttyWrite;
  if (typeof ownTtyWrite !== 'function') return;
  // Invariant: narrowed above via `typeof ownTtyWrite === 'function'`.
  const callDumb = ownTtyWrite as AnyCallable;
  const wrappedDumb = function (this: unknown, s: unknown, key: unknown): unknown {
    const keyObj = record(key) ? key : null;
    const keyName = keyObj?.name;
    const isEscape = keyName === 'escape';
    const isCtrlExit = Boolean(keyObj?.ctrl) && (keyName === 'c' || keyName === 'd');
    const isLineBreak = keyName === 'return' || keyName === 'enter';
    if (
      !isEscape &&
      !isCtrlExit &&
      !isLineBreak &&
      typeof s === 'string' &&
      s.length > 0 &&
      typeof instance.line === 'string' &&
      instance.line.length + s.length > resourceLimits().child.readlineLineBytes
    ) {
      throw fault('E2BIG', 'readline input exceeds 64 KiB');
    }
    return Reflect.apply(callDumb, this, [s, key]);
  };
  Object.defineProperty(wrappedDumb, 'name', {
    value: 'bound _ttyWriteDumb',
    configurable: true,
  });
  instance._ttyWrite = wrappedDumb;
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;

  // Wrap `readline.Interface` and `readline.createInterface` so `process.env.TERM === 'dumb'`
  // instances enforce `readlineLineBytes` before `_ttyWriteDumb` appends to `this.line`.
  const OrigInterface = readlineModule.Interface;
  const WrappedInterface = function Interface(
    this: unknown,
    input?: unknown,
    output?: unknown,
    completer?: unknown,
    terminal?: unknown,
  ): Record<string | symbol, unknown> {
    const target = new.target ?? WrappedInterface;
    // Invariant: `OrigInterface` is the upstream `readline.Interface` constructor, returning an object instance.
    const instance = Reflect.construct(
      OrigInterface,
      [input, output, completer, terminal],
      target,
    ) as Record<string | symbol, unknown>;
    guardDumbTtyWrite(instance);
    return instance;
  };
  WrappedInterface.prototype = OrigInterface.prototype;
  Object.setPrototypeOf(WrappedInterface, Object.getPrototypeOf(OrigInterface));
  Object.defineProperty(OrigInterface.prototype, 'constructor', {
    value: WrappedInterface,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  // Invariant: `WrappedInterface` has the identical call/construct signature and prototype as `OrigInterface`.
  readlineModule.Interface = WrappedInterface as typeof readlineModule.Interface;
  readlineModule.createInterface = function createInterface(
    input?: unknown,
    output?: unknown,
    completer?: unknown,
    terminal?: unknown,
  ): Record<string | symbol, unknown> {
    return Reflect.construct(WrappedInterface, [input, output, completer, terminal]);
  };

  preserveFunctionNames([
    [readlineModule.Interface, 'Interface'],
    [readlineModule.createInterface, 'createInterface'],
    [readlineModule.clearLine, 'clearLine'],
    [readlineModule.clearScreenDown, 'clearScreenDown'],
    [readlineModule.cursorTo, 'cursorTo'],
    [readlineModule.moveCursor, 'moveCursor'],
    [readlineModule.emitKeypressEvents, 'emitKeypressEvents'],
    [readlinePromisesModule.Interface, 'Interface'],
    [readlinePromisesModule.Readline, 'Readline'],
    [readlinePromisesModule.createInterface, 'createInterface'],
  ]);

  // `readable-stream` and guest `process.stdout` invoke `write` completion callbacks with
  // zero arguments (`undefined`) on success, whereas native Node's `Writable` passes `null`.
  const origCommit = readlinePromisesModule.Readline.prototype.commit;
  const wrappedCommit = {
    commit(this: ReadlineBatchThis): Promise<unknown> {
      const PromiseCtor = globalThis.Promise;
      return PromiseCtor.prototype.then.call(origCommit.call(this), (value: unknown) =>
        value === undefined ? null : value,
      );
    },
  }.commit;
  Object.defineProperty(readlinePromisesModule.Readline.prototype, 'commit', {
    value: wrappedCommit,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  // Enforce `resourceLimits().child.readlineLineBytes` on both TTY and non-TTY interfaces.
  const baseProto = readlineInterfaceInternal.Interface.prototype;
  const { kInsertString, kLine_buffer, kNormalWrite, kOnLine } = readlineInterfaceInternal;
  const origInsertString = baseProto[kInsertString];
  const origNormalWrite = baseProto[kNormalWrite];
  const origOnLine = baseProto[kOnLine];

  if (
    typeof origInsertString === 'function' &&
    typeof origNormalWrite === 'function' &&
    typeof origOnLine === 'function'
  ) {
    // Invariant: narrowed above via `typeof ... === 'function'`.
    const callInsert = origInsertString as AnyCallable;
    const callNormalWrite = origNormalWrite as AnyCallable;
    const callOnLine = origOnLine as AnyCallable;

    const wrappedInsertString = function (this: { line?: unknown }, c: unknown): unknown {
      if (
        typeof c === 'string' &&
        c.length > 0 &&
        typeof this.line === 'string' &&
        this.line.length + c.length > resourceLimits().child.readlineLineBytes
      ) {
        throw fault('E2BIG', 'readline input exceeds 64 KiB');
      }
      return Reflect.apply(callInsert, this, [c]);
    };
    Object.defineProperty(wrappedInsertString, 'name', {
      value: origInsertString.name,
      configurable: true,
    });

    const wrappedOnLine = function (this: unknown, line: unknown): unknown {
      if (typeof line === 'string' && line.length > resourceLimits().child.readlineLineBytes) {
        throw fault('E2BIG', 'readline input exceeds 64 KiB');
      }
      return Reflect.apply(callOnLine, this, [line]);
    };
    Object.defineProperty(wrappedOnLine, 'name', {
      value: origOnLine.name,
      configurable: true,
    });

    const wrappedNormalWrite = function (this: object, b: unknown): unknown {
      const result = Reflect.apply(callNormalWrite, this, [b]);
      const buffered: unknown = Reflect.get(this, kLine_buffer);
      if (
        typeof buffered === 'string' &&
        buffered.length > resourceLimits().child.readlineLineBytes
      ) {
        Reflect.set(this, kLine_buffer, null);
        throw fault('E2BIG', 'readline input exceeds 64 KiB');
      }
      return result;
    };
    Object.defineProperty(wrappedNormalWrite, 'name', {
      value: origNormalWrite.name,
      configurable: true,
    });

    baseProto[kInsertString] = wrappedInsertString;
    baseProto[kOnLine] = wrappedOnLine;
    baseProto[kNormalWrite] = wrappedNormalWrite;
    readlineModule.Interface.prototype._insertString = wrappedInsertString;
    readlineModule.Interface.prototype._onLine = wrappedOnLine;
    readlineModule.Interface.prototype._normalWrite = wrappedNormalWrite;
  }
}

export interface ReadlineBuiltinDeps {
  process: { env: Record<string, unknown> };
  setTimeout: (
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export function createReadlineBuiltins({ process, setTimeout, clearTimeout }: ReadlineBuiltinDeps) {
  setGuestProcess(process);
  setGuestTimers(setTimeout, clearTimeout);
  ensureInitialized();
  return {
    readline: readlineModule,
    'readline/promises': readlinePromisesModule,
  };
}
