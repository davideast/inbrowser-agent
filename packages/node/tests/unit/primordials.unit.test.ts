import { afterEach, describe, expect, it } from 'vitest';
import { installContextPromise } from '../../src/context-promise';
import { primordials } from '../../src/node-internal/primordials';
import { setGuestProcess } from '../../src/node-internal/process-ref';

const OriginalPromise = globalThis.Promise;
const originalThenDesc = Object.getOwnPropertyDescriptor(OriginalPromise.prototype, 'then');

describe('primordials PromiseWithResolvers and SafePromisePrototypeFinally', () => {
  afterEach(() => {
    if (originalThenDesc) {
      Object.defineProperty(OriginalPromise.prototype, 'then', originalThenDesc);
    }
    Object.defineProperty(globalThis, 'Promise', {
      configurable: true,
      writable: true,
      value: OriginalPromise,
    });
    setGuestProcess({ env: {} });
  });

  it('populates Function.prototype intrinsics even though typeof Function.prototype is function', () => {
    expect(typeof primordials.FunctionPrototypeToString).toBe('function');
    expect(typeof primordials.FunctionPrototypeSymbolHasInstance).toBe('function');
    expect(typeof primordials.FunctionPrototypeCall).toBe('function');
    expect(typeof primordials.FunctionPrototypeBind).toBe('function');
  });

  it('routes PromiseWithResolvers and SafePromisePrototypeFinally through ContextPromise and preserves async context', async () => {
    let activeStore = 'root';

    const { ContextPromise } = installContextPromise<string>(
      (fn) => {
        const captured = activeStore;
        return (...args: unknown[]) => {
          const prev = activeStore;
          activeStore = captured;
          try {
            return fn(...args);
          } finally {
            activeStore = prev;
          }
        };
      },
      {
        create: () => activeStore,
        run: (owner, fn, args) => {
          const prev = activeStore;
          activeStore = owner;
          try {
            return fn(...args);
          } finally {
            activeStore = prev;
          }
        },
        settled: () => {},
      },
    );
    setGuestProcess({ env: {} });

    // Invariant: `primordials` defines `PromiseWithResolvers` and `SafePromisePrototypeFinally` with these callable shapes.
    const PromiseWithResolvers = primordials.PromiseWithResolvers as () => {
      promise: Promise<unknown>;
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    };
    const SafePromisePrototypeFinally = primordials.SafePromisePrototypeFinally as (
      promise: Promise<unknown>,
      onFinally?: (() => unknown) | null,
    ) => Promise<unknown>;

    let deferred!: ReturnType<typeof PromiseWithResolvers>;
    let finallyStore: string | undefined;
    let chainedPromise!: Promise<unknown>;

    activeStore = 'als-request-42';
    try {
      deferred = PromiseWithResolvers();
      chainedPromise = SafePromisePrototypeFinally(deferred.promise, () => {
        finallyStore = activeStore;
      });
    } finally {
      activeStore = 'outside';
    }

    expect(deferred.promise.constructor).toBe(ContextPromise);
    expect(chainedPromise.constructor).toBe(ContextPromise);

    deferred.resolve('payload');
    await expect(chainedPromise).resolves.toBe('payload');
    expect(finallyStore).toBe('als-request-42');

    // Rejection path also preserves context and rethrows original reason
    let rejectDeferred!: ReturnType<typeof PromiseWithResolvers>;
    let rejectFinallyStore: string | undefined;
    let rejectChained!: Promise<unknown>;

    activeStore = 'als-reject-99';
    try {
      rejectDeferred = PromiseWithResolvers();
      rejectChained = SafePromisePrototypeFinally(rejectDeferred.promise, () => {
        rejectFinallyStore = activeStore;
      });
    } finally {
      activeStore = 'outside';
    }

    rejectDeferred.reject(new Error('boom'));
    await expect(rejectChained).rejects.toThrow('boom');
    expect(rejectFinallyStore).toBe('als-reject-99');
  });
});
