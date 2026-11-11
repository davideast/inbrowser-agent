import type { EventEmitter } from 'events';
import { type DomainModule, createDomainBuiltin } from '../domain';
import { type PunycodeBuiltin, createPunycodeBuiltin } from '../punycode';
import { createReplBuiltin } from '../repl';

export interface ExtraLibBuiltinsDeps {
  process: EventEmitter;
  fs: Record<string, unknown>;
  cwd: () => string;
  setTimeout: (fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => unknown;
  clearTimeout: (timer: unknown) => void;
  setImmediate: (fn: (...args: unknown[]) => void, ...args: unknown[]) => unknown;
  retain: () => void;
  release: () => void;
  util: Record<string, unknown>;
  events: unknown;
  readline: unknown;
  stream: unknown;
  tty: Record<string, unknown>;
  console: Record<string, unknown>;
  asyncHooks: Record<string, unknown>;
  vm: unknown;
  module: unknown;
}

function emitProcessWarning(proc: EventEmitter, message: string, type: string, code: string): void {
  const emitWarning = Reflect.get(proc, 'emitWarning');
  if (typeof emitWarning === 'function') {
    Reflect.apply(emitWarning, proc, [message, type, code]);
  }
}

export function registerExtraLibBuiltins(
  target: Record<string, unknown>,
  deps: ExtraLibBuiltinsDeps,
): void {
  let sysWarned = false;
  let punycodeInstance: PunycodeBuiltin | undefined;
  let domainInstance: DomainModule | undefined;
  let replInstance: Record<string, unknown> | undefined;

  const getDomainModule = (): DomainModule => {
    if (!domainInstance) {
      domainInstance = createDomainBuiltin({
        process: deps.process,
        events: deps.events,
      });
    }
    return domainInstance;
  };

  Object.defineProperties(target, {
    sys: {
      enumerable: true,
      configurable: true,
      get() {
        if (!sysWarned) {
          sysWarned = true;
          emitProcessWarning(
            deps.process,
            'sys is deprecated. Use util instead.',
            'DeprecationWarning',
            'DEP0025',
          );
        }
        return deps.util;
      },
    },
    punycode: {
      enumerable: true,
      configurable: true,
      get() {
        if (!punycodeInstance) {
          emitProcessWarning(
            deps.process,
            'The `punycode` module is deprecated. Please use a userland alternative instead.',
            'DeprecationWarning',
            'DEP0040',
          );
          punycodeInstance = createPunycodeBuiltin();
        }
        return punycodeInstance;
      },
    },
    domain: {
      enumerable: true,
      configurable: true,
      get() {
        return getDomainModule();
      },
    },
    repl: {
      enumerable: true,
      configurable: true,
      get() {
        if (!replInstance) {
          replInstance = createReplBuiltin({
            process: deps.process,
            fs: deps.fs,
            cwd: deps.cwd,
            util: deps.util,
            events: deps.events,
            readline: deps.readline,
            stream: deps.stream,
            console: deps.console,
            vm: deps.vm,
            module: deps.module,
            getDomainModule,
          });
        }
        return replInstance;
      },
    },
  });
}
