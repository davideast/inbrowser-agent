import type { EventEmitter } from 'events';
import { nodeError } from './node-errors';

export interface DomainDeps {
  process: EventEmitter;
  events: unknown;
}

export interface DomainInstance extends EventEmitter {
  members: unknown[];
  domain?: DomainInstance | null;
  enter: () => void;
  exit: () => void;
  add: (ee: unknown) => void;
  remove: (ee: unknown) => void;
  run: <T>(fn: (...args: unknown[]) => T, ...args: unknown[]) => T;
  bind: <F extends (...args: unknown[]) => unknown>(cb: F) => F;
  intercept: (cb: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown;
  _errorHandler: (er: unknown) => boolean;
}

export interface DomainModule {
  Domain: new () => DomainInstance;
  create: () => DomainInstance;
  createDomain: () => DomainInstance;
  active: DomainInstance | null | undefined;
  _stack: DomainInstance[];
}

const patchedEventEmitters = new WeakSet<object>();

function isObjectOrFunction(value: unknown): value is Record<string, unknown> {
  return (value !== null && typeof value === 'object') || typeof value === 'function';
}

export function createDomainBuiltin(deps: DomainDeps): DomainModule {
  const EventEmitterCtor = deps.events;
  if (typeof EventEmitterCtor !== 'function') {
    throw new TypeError('domain requires an EventEmitter constructor');
  }
  // Invariant: `deps.events` is the guest `EventEmitter` class constructor.
  const BaseEmitter = EventEmitterCtor as typeof EventEmitter;
  const proc = deps.process;

  const hasCaptureFn = Reflect.get(proc, 'hasUncaughtExceptionCaptureCallback');
  if (typeof hasCaptureFn === 'function' && Reflect.apply(hasCaptureFn, proc, []) === true) {
    throw nodeError(
      Error,
      'ERR_DOMAIN_CALLBACK_NOT_AVAILABLE',
      'A callback was registered through process.setUncaughtExceptionCaptureCallback(), which is mutually exclusive with using the `domain` module',
    );
  }

  const rawSetCapture = Reflect.get(proc, 'setUncaughtExceptionCaptureCallback');
  const setCapture = (fn: ((err: unknown) => void) | null): void => {
    if (typeof rawSetCapture === 'function') {
      Reflect.apply(rawSetCapture, proc, [fn]);
    }
  };

  let stack: DomainInstance[] = [];

  const setProcessDomain = (dom: DomainInstance | null | undefined): void => {
    Reflect.set(proc, 'domain', dom);
  };

  setProcessDomain(null);

  class Domain extends BaseEmitter {
    declare members: unknown[];
    declare domain?: DomainInstance | null;
    declare enter: () => void;
    declare exit: () => void;
    declare add: (ee: unknown) => void;
    declare remove: (ee: unknown) => void;
    declare run: <T>(fn: (...args: unknown[]) => T, ...args: unknown[]) => T;
    declare bind: <F extends (...args: unknown[]) => unknown>(cb: F) => F;
    declare intercept: (cb: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown;
    declare _errorHandler: (er: unknown) => boolean;

    constructor() {
      super();
      this.members = [];
      this.on('removeListener', updateExceptionCapture);
      this.on('newListener', updateExceptionCapture);
    }
  }

  Object.defineProperty(Domain.prototype, 'members', {
    value: undefined,
    writable: true,
    enumerable: true,
    configurable: true,
  });

  function createDomain(): DomainInstance {
    return new Domain();
  }

  const domainModule: DomainModule = {
    Domain,
    create: createDomain,
    createDomain,
    active: null,
    _stack: stack,
  };

  function updateExceptionCapture(): void {
    const anyHasErrorListener = stack.some((d) => d.listenerCount('error') > 0);
    if (!anyHasErrorListener) {
      setCapture(null);
    } else {
      setCapture(null);
      setCapture((er: unknown) => {
        const current = Reflect.get(proc, 'domain');
        if (isObjectOrFunction(current) && typeof current._errorHandler === 'function') {
          Reflect.apply(current._errorHandler, current, [er]);
        }
      });
    }
  }

  function domainUncaughtExceptionClear(): void {
    stack.length = 0;
    domainModule.active = null;
    setProcessDomain(null);
    updateExceptionCapture();
  }

  Domain.prototype._errorHandler = function _errorHandler(
    this: DomainInstance,
    er: unknown,
  ): boolean {
    let caught = false;
    if (isObjectOrFunction(er)) {
      Object.defineProperty(er, 'domain', {
        configurable: true,
        enumerable: false,
        value: this,
        writable: true,
      });
      er.domainThrown = true;
    }

    while (domainModule.active === this) {
      this.exit();
    }

    if (stack.length === 0) {
      if (this.listenerCount('error') > 0) {
        setCapture(null);
        try {
          caught = this.emit('error', er);
        } finally {
          updateExceptionCapture();
        }
      }
    } else {
      try {
        caught = this.emit('error', er);
      } catch (er2) {
        updateExceptionCapture();
        if (stack.length > 0) {
          const top = stack[stack.length - 1];
          domainModule.active = top;
          setProcessDomain(top);
          caught = top._errorHandler(er2);
        } else {
          throw er2;
        }
      }
    }

    domainUncaughtExceptionClear();
    return caught;
  };

  Domain.prototype.enter = function enter(this: DomainInstance): void {
    domainModule.active = this;
    setProcessDomain(this);
    stack.push(this);
    updateExceptionCapture();
  };

  Domain.prototype.exit = function exit(this: DomainInstance): void {
    const index = stack.lastIndexOf(this);
    if (index === -1) return;
    stack.splice(index);
    const nextActive = stack.length === 0 ? undefined : stack[stack.length - 1];
    domainModule.active = nextActive;
    setProcessDomain(nextActive);
    updateExceptionCapture();
  };

  Domain.prototype.add = function add(this: DomainInstance, ee: unknown): void {
    if (!isObjectOrFunction(ee)) return;
    const currentDom = ee.domain;
    if (currentDom === this) return;
    if (isObjectOrFunction(currentDom) && typeof currentDom.remove === 'function') {
      Reflect.apply(currentDom.remove, currentDom, [ee]);
    }
    if (this.domain && ee instanceof Domain) {
      for (let d: DomainInstance | null | undefined = this.domain; d; d = d.domain) {
        if (ee === d) return;
      }
    }
    Object.defineProperty(ee, 'domain', {
      configurable: true,
      enumerable: false,
      value: this,
      writable: true,
    });
    this.members.push(ee);
  };

  Domain.prototype.remove = function remove(this: DomainInstance, ee: unknown): void {
    if (!isObjectOrFunction(ee)) return;
    ee.domain = null;
    const index = this.members.indexOf(ee);
    if (index !== -1) {
      this.members.splice(index, 1);
    }
  };

  Domain.prototype.run = function run<T>(
    this: DomainInstance,
    fn: (...args: unknown[]) => T,
    ...args: unknown[]
  ): T {
    this.enter();
    const ret = Reflect.apply(fn, this, args);
    this.exit();
    return ret;
  };

  function createIntercepted(
    domain: DomainInstance,
    cb: (...args: unknown[]) => unknown,
  ): (...args: unknown[]) => unknown {
    return function runIntercepted(this: unknown, ...fnargs: unknown[]): unknown {
      if (fnargs[0] && fnargs[0] instanceof Error) {
        const er = fnargs[0];
        Object.assign(er, { domainBound: cb, domainThrown: false });
        Object.defineProperty(er, 'domain', {
          configurable: true,
          enumerable: false,
          value: domain,
          writable: true,
        });
        domain.emit('error', er);
        return undefined;
      }
      domain.enter();
      const ret = Reflect.apply(cb, this, fnargs.slice(1));
      domain.exit();
      return ret;
    };
  }

  function createBound<F extends (...args: unknown[]) => unknown>(
    domain: DomainInstance,
    cb: F,
  ): F {
    function runBound(this: unknown, ...fnargs: unknown[]): unknown {
      domain.enter();
      const ret = Reflect.apply(cb, this, fnargs);
      domain.exit();
      return ret;
    }
    Object.defineProperty(runBound, 'domain', {
      configurable: true,
      enumerable: false,
      value: domain,
      writable: true,
    });
    // Invariant: `runBound` forwards arbitrary arguments and return values matching `cb`.
    return runBound as F;
  }

  Domain.prototype.intercept = function intercept(
    this: DomainInstance,
    cb: (...args: unknown[]) => unknown,
  ): (...args: unknown[]) => unknown {
    return createIntercepted(this, cb);
  };

  Domain.prototype.bind = function bind<F extends (...args: unknown[]) => unknown>(
    this: DomainInstance,
    cb: F,
  ): F {
    return createBound(this, cb);
  };

  // Patch EventEmitter once per process EventEmitter class for domain-routed 'error' events
  if (!patchedEventEmitters.has(BaseEmitter)) {
    patchedEventEmitters.add(BaseEmitter);
    Reflect.set(BaseEmitter, 'usingDomains', true);
    const origInit = Reflect.get(BaseEmitter, 'init');
    if (typeof origInit === 'function') {
      Reflect.set(BaseEmitter, 'init', function domainAwareInit(this: unknown, opts?: unknown) {
        if (isObjectOrFunction(this)) {
          Object.defineProperty(this, 'domain', {
            configurable: true,
            enumerable: false,
            value: null,
            writable: true,
          });
          if (domainModule.active && !(this instanceof Domain)) {
            this.domain = domainModule.active;
          }
        }
        return Reflect.apply(origInit, this, [opts]);
      });
    }

    const origEmit = BaseEmitter.prototype.emit;
    BaseEmitter.prototype.emit = function emit(
      this: EventEmitter,
      type: string | symbol,
      ...args: unknown[]
    ): boolean {
      const domCandidate = Reflect.get(this, 'domain');
      const shouldEmitLocally = type === 'error' && this.listenerCount(type) > 0;
      if (
        shouldEmitLocally ||
        domCandidate === null ||
        domCandidate === undefined ||
        this === proc ||
        !(domCandidate instanceof Domain)
      ) {
        return Reflect.apply(origEmit, this, [type, ...args]);
      }

      const dom: DomainInstance = domCandidate;
      if (type === 'error') {
        const rawErr =
          args.length > 0 && args[0]
            ? args[0]
            : nodeError(Error, 'ERR_UNHANDLED_ERROR', 'Unhandled error.');
        if (isObjectOrFunction(rawErr)) {
          rawErr.domainEmitter = this;
          Object.defineProperty(rawErr, 'domain', {
            configurable: true,
            enumerable: false,
            value: dom,
            writable: true,
          });
          rawErr.domainThrown = false;
        }

        const origDomainsStack = stack.slice();
        const rawOrigActive = Reflect.get(proc, 'domain');
        const origActive: DomainInstance | null | undefined =
          rawOrigActive instanceof Domain || rawOrigActive === null ? rawOrigActive : undefined;

        let idx = stack.length - 1;
        while (idx > -1 && origActive === stack[idx]) {
          idx -= 1;
        }
        if (idx < 0) {
          stack.length = 0;
        } else {
          stack.splice(idx + 1);
        }
        if (stack.length > 0) {
          const top = stack[stack.length - 1];
          domainModule.active = top;
          setProcessDomain(top);
        } else {
          domainModule.active = null;
          setProcessDomain(null);
        }
        updateExceptionCapture();

        dom.emit('error', rawErr);

        stack = origDomainsStack;
        domainModule._stack = stack;
        domainModule.active = origActive;
        setProcessDomain(origActive);
        updateExceptionCapture();
        return false;
      }

      dom.enter();
      const ret = Reflect.apply(origEmit, this, [type, ...args]);
      dom.exit();
      return Boolean(ret);
    };
  }

  return domainModule;
}
