import { CONTEXT_HELPER_PREFIX } from './context-compiler';
import { fault } from './protocol';
import {
  type VmContextSource,
  addedDeclarations,
  checkVmSource,
  prepareVmContextSource,
  prepareVmFunctionSource,
  prepareVmSource,
} from './vm-source';

/**
 * Same-realm approximation of vm contexts (docs/reference/architecture.md, vm
 * section). A Worker cannot create a realm synchronously, so a "context" is the
 * guest's object used as the scope of free identifiers: evaluation runs inside
 * `with (scope)` where `scope` is a Proxy that decides, per identifier, whether
 * the context object, the realm's standard built-ins, or neither answers.
 */

/** What the loader provides: compilation and the two evaluation entry points. */
export interface VmHost {
  /** The async-context compiler when experimental mode is on, else identity. */
  compile(source: string): string;
  /** Indirect eval in the process realm. */
  evaluate(source: string): unknown;
  /**
   * Sloppy `with (holder.scope) return eval(holder.source())` with `this` bound;
   * `eval` there is the realm's intrinsic, so the call is a direct eval.
   */
  evaluateInScope(thisValue: object, holder: ScopeHolder): unknown;
  /** The holder parameter's name, which the scope must never answer for. */
  holderName: string;
}

export interface ScopeHolder {
  scope: object;
  source(): string;
  begin(): undefined;
  hoist(...values: unknown[]): undefined;
}

/**
 * Own property names of a fresh context's global object in Node 22.18 (observed:
 * `vm.runInNewContext('Object.getOwnPropertyNames(globalThis)')`). Free
 * identifiers with these names fall through to this realm's object of the same
 * name, so contexts share built-ins with the process (a documented divergence).
 * Other realm globals (process, Buffer, timers, ...) are not visible, as in Node.
 */
const BUILTINS = new Set([
  'Object',
  'Function',
  'Array',
  'Number',
  'parseFloat',
  'parseInt',
  'Infinity',
  'NaN',
  'undefined',
  'Boolean',
  'String',
  'Symbol',
  'Date',
  'Promise',
  'RegExp',
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'JSON',
  'Math',
  'Intl',
  'ArrayBuffer',
  'Atomics',
  'Uint8Array',
  'Int8Array',
  'Uint16Array',
  'Int16Array',
  'Uint32Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'Uint8ClampedArray',
  'BigUint64Array',
  'BigInt64Array',
  'DataView',
  'Map',
  'BigInt',
  'Set',
  'WeakMap',
  'WeakSet',
  'Proxy',
  'Reflect',
  'FinalizationRegistry',
  'WeakRef',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'unescape',
  'eval',
  'isFinite',
  'isNaN',
  'console',
  'Iterator',
  'SharedArrayBuffer',
  'WebAssembly',
]);

const USE_MAIN_CONTEXT_DEFAULT_LOADER = Symbol('vm_dynamic_import_main_context_default');
const DONT_CONTEXTIFY = Symbol('vm_context_no_contextify');

/** Node's `Received ...` suffix for argument errors. */
function received(value: unknown): string {
  if (value === undefined || value === null) return String(value);
  if (typeof value === 'function') return `function ${value.name}`;
  if (typeof value === 'object') {
    const ctor: unknown = Reflect.get(value, 'constructor');
    return typeof ctor === 'function' && ctor.name
      ? `an instance of ${ctor.name}`
      : 'an instance of Object';
  }
  return `type ${typeof value} (${inspect(value)})`;
}

function inspect(value: unknown): string {
  if (typeof value === 'string')
    return `'${value.length > 28 ? value.slice(0, 25) + '...' : value}'`;
  if (typeof value === 'bigint') return `${value}n`;
  if (Object.is(value, -0)) return '-0';
  return String(value);
}

function invalidType(name: string, expected: string, value: unknown): TypeError {
  const kind = name.includes('.') ? 'property' : 'argument';
  return Object.assign(
    new TypeError(`The "${name}" ${kind} must be ${expected}. Received ${received(value)}`),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** Node's validateObject without flags: null, arrays and functions are rejected. */
function validateObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) throw invalidType(name, 'of type object', value);
}

interface ContextRecord {
  name: string | undefined;
  origin: string | undefined;
  /** Accepted and recorded; not enforced (a documented divergence). */
  codeGeneration: { strings: boolean; wasm: boolean };
  global?: object;
}

export function createVm(host: VmHost) {
  const contexts = new WeakMap<object, ContextRecord>();

  /**
   * Validates context options under Node's property names (`options.name` for
   * createContext, `options.contextName` for runInNewContext).
   */
  function contextOptions(
    options: Record<string, unknown>,
    names: { name: string; origin: string; codeGeneration: string },
  ): Omit<ContextRecord, 'global'> {
    const name = options[names.name];
    if (name !== undefined && typeof name !== 'string')
      throw invalidType(`options.${names.name}`, 'of type string', name);
    const origin = options[names.origin];
    if (origin !== undefined && typeof origin !== 'string')
      throw invalidType(`options.${names.origin}`, 'of type string', origin);
    const codeGeneration = { strings: true, wasm: true };
    const generation = options[names.codeGeneration];
    if (generation !== undefined) {
      validateObject(generation, `options.${names.codeGeneration}`);
      for (const key of ['strings', 'wasm'] as const) {
        const value = generation[key];
        if (value === undefined) continue;
        if (typeof value !== 'boolean')
          throw invalidType(`options.${names.codeGeneration}.${key}`, 'of type boolean', value);
        codeGeneration[key] = value;
      }
    }
    const microtaskMode = options.microtaskMode;
    if (microtaskMode !== undefined && microtaskMode !== 'afterEvaluate')
      throw Object.assign(
        new TypeError(
          `The property 'options.microtaskMode' must be one of: 'afterEvaluate', undefined. Received ${inspect(microtaskMode)}`,
        ),
        { code: 'ERR_INVALID_ARG_VALUE' },
      );
    // Draining microtasks after each evaluation changes ordering; it is not
    // implemented rather than silently ignored.
    if (microtaskMode !== undefined)
      throw fault('ENOSYS', "VM microtaskMode 'afterEvaluate' is not implemented");
    const dynamic = options.importModuleDynamically;
    if (
      dynamic !== undefined &&
      typeof dynamic !== 'function' &&
      dynamic !== USE_MAIN_CONTEXT_DEFAULT_LOADER
    )
      throw invalidType('options.importModuleDynamically', 'of type function', dynamic);
    if (dynamic !== undefined)
      throw fault('ENOSYS', 'VM dynamic import callbacks are not implemented');
    return { name, origin, codeGeneration };
  }

  function contextify(
    contextObject: unknown,
    options: Record<string, unknown>,
    names: { name: string; origin: string; codeGeneration: string },
  ): object {
    if (contextObject === DONT_CONTEXTIFY)
      throw fault('ENOSYS', 'VM contexts without contextifying need a separate realm');
    if (contextObject !== undefined && !isObject(contextObject))
      throw invalidType('object', 'of type object', contextObject);
    if (contextObject !== undefined && contexts.has(contextObject)) return contextObject;
    const record = contextOptions(options, names);
    const context = contextObject ?? {};
    contexts.set(context, record);
    return context;
  }

  function requireContext(value: unknown): object {
    if (!isObject(value)) throw invalidType('object', 'of type object', value);
    if (!contexts.has(value)) throw invalidType('contextifiedObject', 'an vm.Context', value);
    return value;
  }

  /**
   * The context's `globalThis` and top-level `this`: like Node's global proxy it
   * is not the context object, but reads and writes reach it, and the standard
   * built-ins are visible through it.
   */
  function globalFor(context: object): object {
    const record = contexts.get(context);
    if (!record) throw fault('EINVAL', 'Not a vm context');
    if (record.global) return record.global;
    const global: object = new Proxy(context, {
      get(target, key) {
        if (key in target) return Reflect.get(target, key);
        if (key === 'globalThis') return global;
        if (typeof key === 'string' && BUILTINS.has(key)) return Reflect.get(globalThis, key);
        return undefined;
      },
      set: (target, key, value) => Reflect.set(target, key, value),
      has: (target, key) =>
        key in target || key === 'globalThis' || (typeof key === 'string' && BUILTINS.has(key)),
      // Node: a contextified global object cannot be frozen.
      preventExtensions() {
        throw new TypeError('Cannot freeze');
      },
    });
    record.global = global;
    return global;
  }

  /**
   * Runs prepared source with `context` as the scope of free identifiers.
   * `functions` are hoisted onto the context before the body runs; `strict`
   * decides how unknown identifiers fail.
   */
  function evaluateIn(
    context: object,
    prepared: { source: string; strict: boolean; functions: string[]; declared: Set<string> },
  ): unknown {
    const global = globalFor(context);
    const key = host.holderName;
    let source = prepared.source;
    if (prepared.functions.length)
      source = `${key}.hoist(${key}.begin(),${prepared.functions.join(',')});` + source;
    const compiled = host.compile(source);
    // Declarations the compiler added (lowering helpers) stay in the evaluation's
    // own variable scope instead of landing on the context.
    const internal =
      compiled === source ? new Set<string>() : addedDeclarations(compiled, prepared.declared);
    const strict = prepared.strict;
    let entering = true;
    let hoisting = false;
    const hoisted = new Set(prepared.functions);
    const scope = new Proxy(context, {
      has(target, name) {
        if (typeof name !== 'string') return false;
        if (name === key || internal.has(name) || name.startsWith(CONTEXT_HELPER_PREFIX))
          return false;
        // The evaluator's own `eval` call and the prologue's function references
        // resolve past the scope.
        if (name === 'eval' && entering) return false;
        if (hoisting && hoisted.has(name)) return false;
        if (name in target || name === 'globalThis') return true;
        if (BUILTINS.has(name)) return false;
        // Sloppy code: an unknown identifier belongs to the context, so an
        // assignment creates a context property. Strict code: only a realm-only
        // global needs catching here so that it throws instead of resolving.
        return strict ? name in globalThis : true;
      },
      get(target, name) {
        if (name === Symbol.unscopables) return undefined;
        if (name in target) return Reflect.get(target, name);
        if (name === 'globalThis') return global;
        if (strict) throw new ReferenceError(`${String(name)} is not defined`);
        return undefined;
      },
      set(target, name, value) {
        if (strict && !(name in target)) throw new ReferenceError(`${String(name)} is not defined`);
        return Reflect.set(target, name, value);
      },
    });
    return host.evaluateInScope(global, {
      scope,
      source() {
        entering = false;
        return compiled;
      },
      begin() {
        hoisting = true;
        return undefined;
      },
      hoist(_begin: unknown, ...values: unknown[]) {
        hoisting = false;
        prepared.functions.forEach((name, index) => {
          const existing = Object.getOwnPropertyDescriptor(context, name);
          if (existing && !existing.configurable) Reflect.set(context, name, values[index]);
          else
            Object.defineProperty(context, name, {
              value: values[index],
              writable: true,
              enumerable: true,
              configurable: true,
            });
        });
        return undefined;
      },
    });
  }

  const evaluateHere = (code: unknown, options: unknown): unknown =>
    host.evaluate(host.compile(prepareVmSource(code, options)));

  /** Run options (timeout, breakOnSigint, displayErrors) are not implemented. */
  function runOptions(options: unknown): Record<string, unknown> {
    if (options === undefined) return {};
    validateObject(options, 'options');
    return options;
  }
  function rejectRunOptions(options: Record<string, unknown>): void {
    if (
      Object.getPrototypeOf(options) !== Object.prototype &&
      Object.getPrototypeOf(options) !== null
    )
      throw fault('ENOSYS', 'VM options with custom prototypes are not implemented');
    for (const key of Reflect.ownKeys(options))
      throw fault('ENOSYS', `Unsupported VM option ${String(key)}`);
  }

  const NEW_CONTEXT = {
    name: 'contextName',
    origin: 'contextOrigin',
    codeGeneration: 'contextCodeGeneration',
  };
  const NEW_CONTEXT_KEYS = [...Object.values(NEW_CONTEXT), 'microtaskMode'];
  /** Splits runInNewContext options into context options and script options. */
  function splitNewContext(options: unknown): {
    context: Record<string, unknown>;
    script: Record<string, unknown> | string | undefined;
  } {
    if (typeof options === 'string' || options === undefined)
      return { context: {}, script: options };
    validateObject(options, 'options');
    const script: Record<string, unknown> = Object.create(Object.getPrototypeOf(options));
    for (const key of Reflect.ownKeys(options))
      if (typeof key !== 'string' || !NEW_CONTEXT_KEYS.includes(key))
        Object.defineProperty(script, key, Object.getOwnPropertyDescriptor(options, key) ?? {});
    return { context: options, script };
  }

  const coerce = (code: unknown): string => (typeof code === 'string' ? code : `${String(code)}`);

  class Script {
    readonly #code: string;
    readonly #options: unknown;
    #context: VmContextSource | undefined;
    readonly cachedDataRejected = undefined;
    readonly sourceMapURL = undefined;
    constructor(code: unknown, options?: unknown) {
      this.#code = coerce(code);
      this.#options = options;
      checkVmSource(this.#code, options);
    }
    runInThisContext(options?: unknown): unknown {
      rejectRunOptions(runOptions(options));
      return evaluateHere(this.#code, this.#options);
    }
    runInContext(contextifiedObject: unknown, options?: unknown): unknown {
      const context = requireContext(contextifiedObject);
      rejectRunOptions(runOptions(options));
      this.#context ??= prepareVmContextSource(this.#code, this.#options);
      return evaluateIn(context, this.#context);
    }
    runInNewContext(contextObject?: unknown, options?: unknown): unknown {
      const { context, script } = splitNewContext(runOptions(options));
      const created = contextify(contextObject, context, NEW_CONTEXT);
      rejectRunOptions(typeof script === 'object' ? script : {});
      this.#context ??= prepareVmContextSource(this.#code, this.#options);
      return evaluateIn(created, this.#context);
    }
    createCachedData(): never {
      throw fault('ENOSYS', 'VM code cache data is not implemented');
    }
  }

  function compileFunction(code: unknown, params?: unknown, options?: unknown): unknown {
    if (typeof code !== 'string') throw invalidType('code', 'of type string', code);
    const names = params === undefined ? [] : params;
    if (!Array.isArray(names)) throw invalidType('params', 'an instance of Array', names);
    const list: string[] = [];
    names.forEach((name: unknown, index) => {
      if (typeof name !== 'string') throw invalidType(`params[${index}]`, 'of type string', name);
      list.push(name);
    });
    const settings = options === undefined ? {} : options;
    validateObject(settings, 'options');
    const filename = settings.filename === undefined ? '' : settings.filename;
    if (typeof filename !== 'string')
      throw invalidType('options.filename', 'of type string', filename);
    if (settings.cachedData !== undefined || (settings.produceCachedData ?? false) !== false)
      throw fault('ENOSYS', 'VM code cache data is not implemented');
    const parsing = settings.parsingContext;
    if (parsing !== undefined && !(isObject(parsing) && contexts.has(parsing)))
      throw invalidType('options.parsingContext', 'an instance of Context', parsing);
    const extensions = settings.contextExtensions ?? [];
    if (!Array.isArray(extensions))
      throw invalidType('options.contextExtensions', 'an instance of Array', extensions);
    extensions.forEach((extension: unknown, index) => {
      if (!isObject(extension))
        throw invalidType(`options.contextExtensions[${index}]`, 'of type object', extension);
    });
    if (extensions.length)
      throw fault('ENOSYS', 'VM compileFunction context extensions are not implemented');
    if (settings.importModuleDynamically !== undefined)
      throw fault('ENOSYS', 'VM dynamic import callbacks are not implemented');
    // Other keys are ignored, as Node ignores them.
    const prepared = prepareVmFunctionSource(code, list, filename, settings);
    if (parsing === undefined) return host.evaluate(host.compile(prepared.source));
    return evaluateIn(parsing, { ...prepared, functions: [] });
  }

  return {
    Script,
    createScript: (code: unknown, options?: unknown) => new Script(code, options),
    createContext(contextObject?: unknown, options?: unknown): object {
      if (contextObject !== undefined && isObject(contextObject) && contexts.has(contextObject))
        return contextObject;
      if (
        contextObject !== undefined &&
        contextObject !== DONT_CONTEXTIFY &&
        !isObject(contextObject)
      )
        throw invalidType('object', 'of type object', contextObject);
      const settings = options === undefined ? {} : options;
      validateObject(settings, 'options');
      return contextify(contextObject, settings, {
        name: 'name',
        origin: 'origin',
        codeGeneration: 'codeGeneration',
      });
    },
    isContext(object: unknown): boolean {
      if (!isObject(object)) throw invalidType('object', 'of type object', object);
      return contexts.has(object);
    },
    runInThisContext: (code: unknown, options?: unknown): unknown => evaluateHere(code, options),
    runInContext(code: unknown, contextifiedObject: unknown, options?: unknown): unknown {
      const context = requireContext(contextifiedObject);
      return evaluateIn(context, prepareVmContextSource(coerce(code), options));
    },
    runInNewContext(code: unknown, contextObject?: unknown, options?: unknown): unknown {
      const { context, script } = splitNewContext(options);
      const created = contextify(contextObject, context, NEW_CONTEXT);
      return evaluateIn(created, prepareVmContextSource(coerce(code), script));
    },
    compileFunction,
    constants: Object.freeze(
      Object.assign(Object.create(null), { USE_MAIN_CONTEXT_DEFAULT_LOADER, DONT_CONTEXTIFY }),
    ),
  };
}
