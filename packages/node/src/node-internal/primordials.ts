// Browser-safe port of Node.js v22.18.0 lib/internal/per_context/primordials.js.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { onGuestProcessChange } from './process-ref';

type AnyFunction = (...args: unknown[]) => unknown;
type AnyConstructor = abstract new (...args: never[]) => object;

const {
  defineProperty: ReflectDefineProperty,
  getOwnPropertyDescriptor: ReflectGetOwnPropertyDescriptor,
  ownKeys: ReflectOwnKeys,
  getPrototypeOf: ReflectGetPrototypeOf,
  apply: ReflectApply,
  construct: ReflectConstruct,
  get: ReflectGet,
  set: ReflectSet,
} = Reflect;

const { apply, bind, call } = Function.prototype;
// Invariant: `Function.prototype.bind.bind(Function.prototype.call)` produces `(fn) => (thisArg, ...args) => fn.call(thisArg, ...args)`.
const uncurryThis = bind.bind(call) as <T extends AnyFunction>(
  fn: T,
) => (thisArg: unknown, ...args: unknown[]) => unknown;
// Invariant: `Function.prototype.bind.bind(Function.prototype.apply)` produces `(fn, thisArg) => (argsArray) => fn.apply(thisArg, argsArray)`.
const applyBind = bind.bind(apply) as <T extends AnyFunction>(
  fn: T,
  thisArg?: unknown,
) => (...args: unknown[]) => unknown;

function createNullProtoRecord<V>(): Record<PropertyKey, V> {
  // Invariant: `Object.create(null)` returns a fresh dictionary object with no prototype chain.
  return Object.create(null) as Record<PropertyKey, V>;
}

function nullProtoDescriptor(desc: PropertyDescriptor): PropertyDescriptor {
  // Invariant: copying descriptor fields onto `Object.create(null)` prevents `Object.prototype` getter/setter interference during `Reflect.defineProperty`.
  return Object.assign(Object.create(null) as PropertyDescriptor, desc);
}

const primordialsRecord: Record<PropertyKey, unknown> = createNullProtoRecord<unknown>();
primordialsRecord.uncurryThis = uncurryThis;
primordialsRecord.applyBind = applyBind;

const varargsMethods = new Set([
  'ArrayOf',
  'ArrayPrototypePush',
  'ArrayPrototypeUnshift',
  'MathHypot',
  'MathMax',
  'MathMin',
  'StringFromCharCode',
  'StringFromCodePoint',
  'StringPrototypeConcat',
  'TypedArrayOf',
]);

function getNewKey(key: string | symbol): string {
  if (typeof key === 'symbol') {
    const desc = key.description ?? '';
    return `Symbol${desc[7]?.toUpperCase() ?? ''}${desc.slice(8)}`;
  }
  return `${key[0]?.toUpperCase() ?? ''}${key.slice(1)}`;
}

function copyAccessor(
  dest: Record<PropertyKey, unknown>,
  prefix: string,
  key: string,
  desc: PropertyDescriptor,
): void {
  const getter: unknown = desc.get;
  if (typeof getter === 'function') {
    // Invariant: narrowed above via `typeof getter === 'function'`.
    const fn = getter as AnyFunction;
    ReflectDefineProperty(
      dest,
      `${prefix}Get${key}`,
      nullProtoDescriptor({ value: uncurryThis(fn), enumerable: desc.enumerable }),
    );
  }
  const setter: unknown = desc.set;
  if (typeof setter === 'function') {
    // Invariant: narrowed above via `typeof setter === 'function'`.
    const fn = setter as AnyFunction;
    ReflectDefineProperty(
      dest,
      `${prefix}Set${key}`,
      nullProtoDescriptor({ value: uncurryThis(fn), enumerable: desc.enumerable }),
    );
  }
}

function copyPropsRenamed(src: object, dest: Record<PropertyKey, unknown>, prefix: string): void {
  for (const key of ReflectOwnKeys(src)) {
    const newKey = getNewKey(key);
    const desc = ReflectGetOwnPropertyDescriptor(src, key);
    if (!desc) continue;
    if ('get' in desc) {
      copyAccessor(dest, prefix, newKey, desc);
    } else {
      const name = `${prefix}${newKey}`;
      ReflectDefineProperty(dest, name, nullProtoDescriptor(desc));
      const rawValue: unknown = desc.value;
      if (varargsMethods.has(name) && typeof rawValue === 'function') {
        // Invariant: narrowed above via `typeof rawValue === 'function'`.
        ReflectDefineProperty(
          dest,
          `${name}Apply`,
          nullProtoDescriptor({ value: applyBind(rawValue as AnyFunction, src) }),
        );
      }
    }
  }
}

function copyPropsRenamedBound(
  src: object,
  dest: Record<PropertyKey, unknown>,
  prefix: string,
): void {
  for (const key of ReflectOwnKeys(src)) {
    const newKey = getNewKey(key);
    const desc = ReflectGetOwnPropertyDescriptor(src, key);
    if (!desc) continue;
    if ('get' in desc) {
      copyAccessor(dest, prefix, newKey, desc);
    } else {
      const rawValue: unknown = desc.value;
      const boundDesc: PropertyDescriptor = { ...desc };
      if (typeof rawValue === 'function') {
        // Invariant: narrowed above via `typeof rawValue === 'function'`.
        boundDesc.value = (rawValue as AnyFunction).bind(src);
      }
      const name = `${prefix}${newKey}`;
      ReflectDefineProperty(dest, name, nullProtoDescriptor(boundDesc));
      if (varargsMethods.has(name) && typeof rawValue === 'function') {
        // Invariant: narrowed above via `typeof rawValue === 'function'`.
        ReflectDefineProperty(
          dest,
          `${name}Apply`,
          nullProtoDescriptor({ value: applyBind(rawValue as AnyFunction, src) }),
        );
      }
    }
  }
}

function copyPrototype(src: object, dest: Record<PropertyKey, unknown>, prefix: string): void {
  for (const key of ReflectOwnKeys(src)) {
    const newKey = getNewKey(key);
    const desc = ReflectGetOwnPropertyDescriptor(src, key);
    if (!desc) continue;
    if ('get' in desc) {
      copyAccessor(dest, prefix, newKey, desc);
    } else {
      const rawValue: unknown = desc.value;
      const protoDesc: PropertyDescriptor = { ...desc };
      if (typeof rawValue === 'function') {
        // Invariant: narrowed above via `typeof rawValue === 'function'`.
        protoDesc.value = uncurryThis(rawValue as AnyFunction);
      }
      const name = `${prefix}${newKey}`;
      ReflectDefineProperty(dest, name, nullProtoDescriptor(protoDesc));
      if (varargsMethods.has(name) && typeof rawValue === 'function') {
        // Invariant: narrowed above via `typeof rawValue === 'function'`.
        ReflectDefineProperty(
          dest,
          `${name}Apply`,
          nullProtoDescriptor({ value: applyBind(rawValue as AnyFunction) }),
        );
      }
    }
  }
}

primordialsRecord.Proxy = Proxy;
primordialsRecord.globalThis = globalThis;

for (const fn of [decodeURI, decodeURIComponent, encodeURI, encodeURIComponent, escape, unescape]) {
  primordialsRecord[fn.name] = fn;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

for (const name of ['Atomics', 'JSON', 'Math', 'Proxy', 'Reflect'] as const) {
  const ns: unknown = ReflectGet(globalThis, name);
  if (isObjectLike(ns)) {
    copyPropsRenamed(ns, primordialsRecord, name);
  }
}

const intrinsicNames = [
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'DataView',
  'Date',
  'Error',
  'EvalError',
  'FinalizationRegistry',
  'Float32Array',
  'Float64Array',
  'Function',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Map',
  'Number',
  'Object',
  'RangeError',
  'ReferenceError',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakRef',
  'WeakSet',
] as const;

for (const name of intrinsicNames) {
  const original: unknown = ReflectGet(globalThis, name);
  if (typeof original !== 'function') continue;
  primordialsRecord[name] = original;
  copyPropsRenamed(original, primordialsRecord, name);
  const proto: unknown = original.prototype;
  if (isObjectLike(proto)) {
    copyPrototype(proto, primordialsRecord, `${name}Prototype`);
  }
}

const nativePromiseWithResolvers: unknown = ReflectGet(Promise, 'withResolvers');
let ActivePromise: PromiseConstructor = Promise;
let activePromiseThen = Promise.prototype.then;
let activePromiseCatch = Promise.prototype.catch;
let activePromiseFinally = Promise.prototype.finally;

onGuestProcessChange(() => {
  ActivePromise = globalThis.Promise;
  activePromiseThen = ActivePromise.prototype.then;
  activePromiseCatch = ActivePromise.prototype.catch;
  activePromiseFinally = ActivePromise.prototype.finally;
});

const DynamicPromise: PromiseConstructor = new Proxy(Promise, {
  construct(_target, args, newTarget) {
    return ReflectConstruct(
      ActivePromise,
      args,
      newTarget === DynamicPromise ? ActivePromise : newTarget,
    );
  },
  apply(_target, thisArg, args) {
    // Invariant: `ActivePromise` is always a callable constructor function (`Promise` or `ContextPromise`).
    return ReflectApply(ActivePromise as unknown as AnyFunction, thisArg, args);
  },
  get(_target, prop, receiver) {
    return ReflectGet(ActivePromise, prop, receiver === DynamicPromise ? ActivePromise : receiver);
  },
});

primordialsRecord.Promise = DynamicPromise;
copyPropsRenamedBound(Promise, primordialsRecord, 'Promise');
copyPrototype(Promise.prototype, primordialsRecord, 'PromisePrototype');
primordialsRecord.PromiseResolve = (value?: unknown) => ActivePromise.resolve(value);
primordialsRecord.PromiseReject = (reason?: unknown) => ActivePromise.reject(reason);
primordialsRecord.PromiseAll = (values: Iterable<unknown>) => ActivePromise.all(values);
primordialsRecord.PromiseAllSettled = (values: Iterable<unknown>) =>
  ActivePromise.allSettled(values);
primordialsRecord.PromiseAny = (values: Iterable<unknown>) => ActivePromise.any(values);
primordialsRecord.PromiseRace = (values: Iterable<unknown>) => ActivePromise.race(values);
primordialsRecord.PromiseWithResolvers = () => {
  if (typeof nativePromiseWithResolvers === 'function') {
    // Invariant: `Promise.withResolvers` is generic on `this` (`NewPromiseCapability(ActivePromise)`), creating a `ContextPromise` when installed.
    return ReflectApply(nativePromiseWithResolvers as AnyFunction, ActivePromise, []);
  }
  let resolve!: (value: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new DynamicPromise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const PromisePrototypeThen = (
  self: Promise<unknown>,
  onFulfilled?: ((value: unknown) => unknown) | null,
  onRejected?: ((reason: unknown) => unknown) | null,
): Promise<unknown> =>
  // Invariant: `activePromiseThen` is `Promise.prototype.then` / `ContextPromise.prototype.then`, which always returns a Promise.
  ReflectApply(activePromiseThen, self, [onFulfilled, onRejected]) as Promise<unknown>;

const PromiseResolve = (value?: unknown): Promise<unknown> => ActivePromise.resolve(value);

primordialsRecord.PromisePrototypeThen = PromisePrototypeThen;
primordialsRecord.PromisePrototypeCatch = (
  self: Promise<unknown>,
  onRejected?: ((reason: unknown) => unknown) | null,
) => ReflectApply(activePromiseCatch, self, [onRejected]);
primordialsRecord.PromisePrototypeFinally = (
  self: Promise<unknown>,
  onFinally?: (() => void) | null,
) => ReflectApply(activePromiseFinally, self, [onFinally]);

// Invariant: ES262 `%TypedArray%` is the prototype of `Uint8Array` and owns `.prototype`.
const TypedArrayBase = ReflectGetPrototypeOf(Uint8Array) as object & { prototype: object };
// Invariant: ES262 `%ArrayIteratorPrototype%` and `%StringIteratorPrototype%` are non-null objects.
const ArrayIteratorPrototypeObj = ReflectGetPrototypeOf(
  Array.prototype[Symbol.iterator](),
) as object;
const StringIteratorPrototypeObj = ReflectGetPrototypeOf(
  String.prototype[Symbol.iterator](),
) as object;

for (const { name, original } of [
  { name: 'TypedArray', original: TypedArrayBase },
  { name: 'ArrayIterator', original: { prototype: ArrayIteratorPrototypeObj } },
  { name: 'StringIterator', original: { prototype: StringIteratorPrototypeObj } },
]) {
  primordialsRecord[name] = original;
  copyPrototype(original, primordialsRecord, name);
  copyPrototype(original.prototype, primordialsRecord, `${name}Prototype`);
}

primordialsRecord.IteratorPrototype = ReflectGetPrototypeOf(ArrayIteratorPrototypeObj);

const ObjectDefineProperties = Object.defineProperties;
const ObjectDefineProperty = Object.defineProperty;
const ObjectFreeze = Object.freeze;
const ObjectSetPrototypeOf = Object.setPrototypeOf;

const createSafeIterator = <T>(
  factory: (self: Iterable<T>) => Iterator<T>,
  next: (iter: Iterator<T>) => IteratorResult<T>,
) => {
  class SafeIterator implements IterableIterator<T> {
    _iterator: Iterator<T>;
    constructor(iterable: Iterable<T>) {
      this._iterator = factory(iterable);
    }
    next(): IteratorResult<T> {
      return next(this._iterator);
    }
    [Symbol.iterator](): IterableIterator<T> {
      return this;
    }
  }
  ObjectSetPrototypeOf(SafeIterator.prototype, null);
  ObjectFreeze(SafeIterator.prototype);
  ObjectFreeze(SafeIterator);
  return SafeIterator;
};

// Invariant: populated above by `copyPrototype` on `Array.prototype`, `%ArrayIteratorPrototype%`, `String.prototype`, and `%StringIteratorPrototype%`.
const ArrayPrototypeSymbolIterator = primordialsRecord.ArrayPrototypeSymbolIterator as (
  self: Iterable<unknown>,
) => Iterator<unknown>;
const ArrayIteratorPrototypeNext = primordialsRecord.ArrayIteratorPrototypeNext as (
  iter: Iterator<unknown>,
) => IteratorResult<unknown>;
const StringPrototypeSymbolIterator = primordialsRecord.StringPrototypeSymbolIterator as (
  self: Iterable<string>,
) => Iterator<string>;
const StringIteratorPrototypeNext = primordialsRecord.StringIteratorPrototypeNext as (
  iter: Iterator<string>,
) => IteratorResult<string>;

const SafeArrayIterator = createSafeIterator(
  ArrayPrototypeSymbolIterator,
  ArrayIteratorPrototypeNext,
);
const SafeStringIterator = createSafeIterator(
  StringPrototypeSymbolIterator,
  StringIteratorPrototypeNext,
);
primordialsRecord.SafeArrayIterator = SafeArrayIterator;
primordialsRecord.SafeStringIterator = SafeStringIterator;

const copyProps = (src: object, dest: object): void => {
  for (const key of ReflectOwnKeys(src)) {
    if (!ReflectGetOwnPropertyDescriptor(dest, key)) {
      const desc = ReflectGetOwnPropertyDescriptor(src, key);
      if (desc) {
        ReflectDefineProperty(dest, key, nullProtoDescriptor(desc));
      }
    }
  }
};

const makeSafe = <U extends AnyConstructor, S extends AnyConstructor>(unsafe: U, safe: S): S => {
  const unsafeProto: unknown = unsafe.prototype;
  const safeProto: unknown = safe.prototype;
  if (isObjectLike(unsafeProto) && isObjectLike(safeProto)) {
    if (Symbol.iterator in unsafeProto) {
      // Invariant: only iterable built-ins (`Map`, `Set`) enter this branch and all support zero-arg `ReflectConstruct`.
      const dummy = ReflectConstruct(unsafe as unknown as new () => Iterable<unknown>, []);
      let nextFn: ((iter: Iterator<unknown>) => IteratorResult<unknown>) | undefined;
      for (const key of ReflectOwnKeys(unsafeProto)) {
        if (!ReflectGetOwnPropertyDescriptor(safeProto, key)) {
          const desc = ReflectGetOwnPropertyDescriptor(unsafeProto, key);
          if (!desc) continue;
          const copyDesc: PropertyDescriptor = { ...desc };
          const method: unknown = desc.value;
          if (typeof method === 'function' && method.length === 0) {
            const probe: unknown = ReflectApply(method as AnyFunction, dummy, []);
            if (typeof probe === 'object' && probe !== null && Symbol.iterator in probe) {
              // Invariant: zero-arg method on iterable collection returning an iterable is an iterator factory (`entries`, `keys`, `values`, `[Symbol.iterator]`).
              const createIterator = uncurryThis(method as AnyFunction) as (
                self: Iterable<unknown>,
              ) => Iterator<unknown>;
              const sampleIter = createIterator(dummy);
              // Invariant: ES262 collection iterators always expose a callable `.next` method.
              nextFn ??= uncurryThis(sampleIter.next as unknown as AnyFunction) as (
                iter: Iterator<unknown>,
              ) => IteratorResult<unknown>;
              const IterClass = createSafeIterator(createIterator, nextFn);
              copyDesc.value = function (this: Iterable<unknown>) {
                return new IterClass(this);
              };
            }
          }
          ReflectDefineProperty(safeProto, key, nullProtoDescriptor(copyDesc));
        }
      }
    } else {
      copyProps(unsafeProto, safeProto);
    }
    ObjectSetPrototypeOf(safeProto, null);
    ObjectFreeze(safeProto);
  }
  copyProps(unsafe, safe);
  ObjectFreeze(safe);
  return safe;
};

primordialsRecord.makeSafe = makeSafe;

primordialsRecord.SafeMap = makeSafe(
  Map,
  class SafeMap<K, V> extends Map<K, V> {
    constructor(entries?: Iterable<readonly [K, V]> | null) {
      super(entries);
    }
  },
);

primordialsRecord.SafeWeakMap = makeSafe(
  WeakMap,
  class SafeWeakMap<K extends WeakKey, V> extends WeakMap<K, V> {
    constructor(entries?: Iterable<readonly [K, V]> | null) {
      if (entries) super(entries);
      else super();
    }
  },
);

primordialsRecord.SafeSet = makeSafe(
  Set,
  class SafeSet<T> extends Set<T> {
    constructor(values?: Iterable<T> | null) {
      super(values);
    }
  },
);

primordialsRecord.SafeWeakSet = makeSafe(
  WeakSet,
  class SafeWeakSet<T extends WeakKey> extends WeakSet<T> {
    constructor(values?: Iterable<T> | null) {
      if (values) super(values);
      else super();
    }
  },
);

primordialsRecord.SafeFinalizationRegistry = makeSafe(
  FinalizationRegistry,
  class SafeFinalizationRegistry<T> extends FinalizationRegistry<T> {
    constructor(cleanupCallback: (heldValue: T) => void) {
      super(cleanupCallback);
    }
  },
);

primordialsRecord.SafeWeakRef = makeSafe(
  WeakRef,
  class SafeWeakRef<T extends WeakKey> extends WeakRef<T> {
    constructor(target: T) {
      super(target);
    }
  },
);

primordialsRecord.SafeRegExp = makeSafe(
  RegExp,
  class SafeRegExp extends RegExp {
    constructor(pattern: RegExp | string, flags?: string) {
      super(pattern, flags);
    }
  },
);

const SafePromise = makeSafe(
  Promise,
  class SafePromiseClass<T> extends Promise<T> {
    constructor(
      executor: (
        resolve: (value: T | PromiseLike<T>) => void,
        reject: (reason?: unknown) => void,
      ) => void,
    ) {
      super(executor);
    }
  },
);

primordialsRecord.SafePromisePrototypeFinally = (
  thisPromise: Promise<unknown>,
  onFinally?: (() => unknown) | null,
) =>
  PromisePrototypeThen(
    thisPromise,
    typeof onFinally === 'function'
      ? (value: unknown) => PromisePrototypeThen(PromiseResolve(onFinally()), () => value)
      : undefined,
    typeof onFinally === 'function'
      ? (reason: unknown) =>
          PromisePrototypeThen(PromiseResolve(onFinally()), () => {
            throw reason;
          })
      : undefined,
  );

// Invariant: ES262 `async function* () {}` prototype chain owns `%AsyncIteratorPrototype%`.
primordialsRecord.AsyncIteratorPrototype = ReflectGetPrototypeOf(
  (ReflectGetPrototypeOf(async function* () {}) as { prototype: object }).prototype,
);

const arrayToSafePromiseIterable = (
  promises: unknown[],
  mapFn?: ((v: unknown, k: number) => unknown) | null,
): Iterable<unknown> =>
  new SafeArrayIterator(
    promises.map(
      (promise, i) =>
        new SafePromise<unknown>((a, b) =>
          PromisePrototypeThen(PromiseResolve(mapFn == null ? promise : mapFn(promise, i)), a, b),
        ),
    ),
  );

primordialsRecord.SafePromiseAll = (
  promises: unknown[],
  mapFn?: ((v: unknown, k: number) => unknown) | null,
) =>
  new DynamicPromise((a, b) =>
    SafePromise.all(arrayToSafePromiseIterable(promises, mapFn)).then(a, b),
  );

primordialsRecord.SafePromiseAllReturnArrayLike = (
  promises: ArrayLike<unknown>,
  mapFn?: ((v: unknown, k: number) => unknown) | null,
) =>
  new DynamicPromise((resolve, reject) => {
    const { length } = promises;
    const returnVal = new Array<unknown>(length);
    ObjectSetPrototypeOf(returnVal, null);
    if (length === 0) resolve(returnVal);
    let pendingPromises = length;
    for (let i = 0; i < length; i++) {
      const promise = mapFn != null ? mapFn(promises[i], i) : promises[i];
      PromisePrototypeThen(
        PromiseResolve(promise),
        (result) => {
          returnVal[i] = result;
          if (--pendingPromises === 0) resolve(returnVal);
        },
        reject,
      );
    }
  });

primordialsRecord.SafePromiseAllReturnVoid = (
  promises: ArrayLike<unknown>,
  mapFn?: ((v: unknown, k: number) => unknown) | null,
) =>
  new DynamicPromise<void>((resolve, reject) => {
    let pendingPromises = promises.length;
    if (pendingPromises === 0) resolve();
    const onFulfilled = () => {
      if (--pendingPromises === 0) resolve();
    };
    for (let i = 0; i < promises.length; i++) {
      const promise = mapFn != null ? mapFn(promises[i], i) : promises[i];
      PromisePrototypeThen(PromiseResolve(promise), onFulfilled, reject);
    }
  });

primordialsRecord.SafePromiseAllSettled = (
  promises: unknown[],
  mapFn?: ((v: unknown, k: number) => unknown) | null,
) =>
  new DynamicPromise((a, b) =>
    SafePromise.allSettled(arrayToSafePromiseIterable(promises, mapFn)).then(a, b),
  );

primordialsRecord.SafePromiseAllSettledReturnVoid = (
  promises: ArrayLike<unknown>,
  mapFn?: ((v: unknown, k: number) => unknown) | null,
) =>
  new DynamicPromise<void>((resolve) => {
    let pendingPromises = promises.length;
    if (pendingPromises === 0) resolve();
    const onSettle = () => {
      if (--pendingPromises === 0) resolve();
    };
    for (let i = 0; i < promises.length; i++) {
      const promise = mapFn != null ? mapFn(promises[i], i) : promises[i];
      PromisePrototypeThen(PromiseResolve(promise), onSettle, onSettle);
    }
  });

primordialsRecord.SafePromiseAny = (
  promises: unknown[],
  mapFn?: ((v: unknown, k: number) => unknown) | null,
) =>
  new DynamicPromise((a, b) =>
    SafePromise.any(arrayToSafePromiseIterable(promises, mapFn)).then(a, b),
  );

primordialsRecord.SafePromiseRace = (
  promises: unknown[],
  mapFn?: ((v: unknown, k: number) => unknown) | null,
) =>
  new DynamicPromise((a, b) =>
    SafePromise.race(arrayToSafePromiseIterable(promises, mapFn)).then(a, b),
  );

const OriginalRegExpPrototypeExec = RegExp.prototype.exec;
const OriginalRegExpPrototypeSymbolMatch = RegExp.prototype[Symbol.match];
const OriginalRegExpPrototypeSymbolMatchAll = RegExp.prototype[Symbol.matchAll];
const OriginalRegExpPrototypeSymbolReplace = RegExp.prototype[Symbol.replace];
const OriginalRegExpPrototypeSymbolSearch = RegExp.prototype[Symbol.search];
const OriginalRegExpPrototypeSymbolSplit = RegExp.prototype[Symbol.split];

// Invariant: populated above by `copyPrototype` on `RegExp.prototype`.
const RegExpPrototypeExec = primordialsRecord.RegExpPrototypeExec as (
  rx: RegExp,
  str: string,
) => RegExpExecArray | null;
const RegExpPrototypeGetDotAll = primordialsRecord.RegExpPrototypeGetDotAll as (
  rx: RegExp,
) => boolean;
const RegExpPrototypeGetFlags = primordialsRecord.RegExpPrototypeGetFlags as (rx: RegExp) => string;
const RegExpPrototypeGetGlobal = primordialsRecord.RegExpPrototypeGetGlobal as (
  rx: RegExp,
) => boolean;
const RegExpPrototypeGetHasIndices = primordialsRecord.RegExpPrototypeGetHasIndices as (
  rx: RegExp,
) => boolean;
const RegExpPrototypeGetIgnoreCase = primordialsRecord.RegExpPrototypeGetIgnoreCase as (
  rx: RegExp,
) => boolean;
const RegExpPrototypeGetMultiline = primordialsRecord.RegExpPrototypeGetMultiline as (
  rx: RegExp,
) => boolean;
const RegExpPrototypeGetSource = primordialsRecord.RegExpPrototypeGetSource as (
  rx: RegExp,
) => string;
const RegExpPrototypeGetSticky = primordialsRecord.RegExpPrototypeGetSticky as (
  rx: RegExp,
) => boolean;
const RegExpPrototypeGetUnicode = primordialsRecord.RegExpPrototypeGetUnicode as (
  rx: RegExp,
) => boolean;

class RegExpLikeForStringSplitting {
  #regex: RegExp;
  constructor(...args: unknown[]) {
    // Invariant: `ReflectConstruct(RegExp, args)` always constructs a `RegExp` instance.
    this.#regex = ReflectConstruct(RegExp, args) as RegExp;
  }
  get lastIndex(): number {
    return Number(ReflectGet(this.#regex, 'lastIndex'));
  }
  set lastIndex(value: number) {
    ReflectSet(this.#regex, 'lastIndex', value);
  }
  exec(...args: unknown[]): RegExpExecArray | null {
    // Invariant: `RegExp.prototype.exec` returns `RegExpExecArray | null`.
    return ReflectApply(OriginalRegExpPrototypeExec, this.#regex, args) as RegExpExecArray | null;
  }
}
ObjectSetPrototypeOf(RegExpLikeForStringSplitting.prototype, null);

primordialsRecord.hardenRegExp = function hardenRegExp(pattern: RegExp): RegExp {
  ObjectDefineProperties(pattern, {
    [Symbol.match]: nullProtoDescriptor({
      configurable: true,
      value: OriginalRegExpPrototypeSymbolMatch,
    }),
    [Symbol.matchAll]: nullProtoDescriptor({
      configurable: true,
      value: OriginalRegExpPrototypeSymbolMatchAll,
    }),
    [Symbol.replace]: nullProtoDescriptor({
      configurable: true,
      value: OriginalRegExpPrototypeSymbolReplace,
    }),
    [Symbol.search]: nullProtoDescriptor({
      configurable: true,
      value: OriginalRegExpPrototypeSymbolSearch,
    }),
    [Symbol.split]: nullProtoDescriptor({
      configurable: true,
      value: OriginalRegExpPrototypeSymbolSplit,
    }),
    constructor: nullProtoDescriptor({
      configurable: true,
      value: {
        [Symbol.species]: RegExpLikeForStringSplitting,
      },
    }),
    dotAll: nullProtoDescriptor({
      configurable: true,
      value: RegExpPrototypeGetDotAll(pattern),
    }),
    exec: nullProtoDescriptor({
      configurable: true,
      value: OriginalRegExpPrototypeExec,
    }),
    global: nullProtoDescriptor({
      configurable: true,
      value: RegExpPrototypeGetGlobal(pattern),
    }),
    hasIndices: nullProtoDescriptor({
      configurable: true,
      value: RegExpPrototypeGetHasIndices(pattern),
    }),
    ignoreCase: nullProtoDescriptor({
      configurable: true,
      value: RegExpPrototypeGetIgnoreCase(pattern),
    }),
    multiline: nullProtoDescriptor({
      configurable: true,
      value: RegExpPrototypeGetMultiline(pattern),
    }),
    source: nullProtoDescriptor({
      configurable: true,
      value: RegExpPrototypeGetSource(pattern),
    }),
    sticky: nullProtoDescriptor({
      configurable: true,
      value: RegExpPrototypeGetSticky(pattern),
    }),
    unicode: nullProtoDescriptor({
      configurable: true,
      value: RegExpPrototypeGetUnicode(pattern),
    }),
  });
  ObjectDefineProperty(
    pattern,
    'flags',
    nullProtoDescriptor({
      configurable: true,
      value: RegExpPrototypeGetFlags(pattern),
    }),
  );
  return pattern;
};

primordialsRecord.SafeStringPrototypeSearch = (str: string, regexp: RegExp): number => {
  regexp.lastIndex = 0;
  const match = RegExpPrototypeExec(regexp, str);
  return match ? match.index : -1;
};

ObjectSetPrototypeOf(primordialsRecord, null);
ObjectFreeze(primordialsRecord);

export const primordials: Readonly<Record<PropertyKey, unknown>> = primordialsRecord;
