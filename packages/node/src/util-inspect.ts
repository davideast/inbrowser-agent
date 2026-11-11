// util.inspect after the `util` 0.12.5 package's inspect (util.js), with Node.js
// v22.18.0 behavior from lib/util.js and lib/internal/util/inspect.js where
// noted. This file is a derivative work retained under their license (the
// package's LICENSE; also vendor/node-v22.18.0/LICENSE):
//
//   Copyright Joyent, Inc. and other Node contributors. All rights reserved.
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to
//   deal in the Software without restriction, including without limitation the
//   rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
//   sell copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
//   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
//   IN THE SOFTWARE.
//
// The package's formatter is internal to it, so it is reproduced here: object,
// array, error, date and regexp output, line breaking and circular markers are
// the package's. Three things differ from the package, each after Node:
//
// - `Symbol.for('nodejs.util.inspect.custom')` hooks are called with Node's
//   convention, `(depth, options, inspect)`. A legacy `inspect()` method on the
//   value (own or inherited) is still called first, as the package does; Node
//   never calls it. Both are skipped when the caller sets customInspect: false.
// - Functions are described as Node's getFunctionBase and getClassBase do
//   ([AsyncFunction: f], [class B extends A], own properties after the
//   description) instead of [Function: f].
// - A symbol at the top level prints its description.
import { tokenizer } from 'acorn';
import { inspect as packageInspect } from 'util/';
import { parseEnv as parseDotenv } from './env-file';
import { invalidArgType } from './node-errors';

const custom = Symbol.for('nodejs.util.inspect.custom');

type Stylize = (text: string, style: string) => string;

/** The package's formatting state; user options are copied onto it. */
interface Context {
  seen: unknown[];
  stylize: Stylize;
  showHidden?: unknown;
  depth?: unknown;
  colors?: unknown;
  customInspect?: unknown;
  [key: string]: unknown;
}

// The defaults Node's getUserOptions reports; user-set options override them.
function userOptions(ctx: Context): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...ctx };
  // Internal bookkeeping, not an option.
  delete rest.seen;
  delete rest.budget;
  return {
    showHidden: false,
    depth: 2,
    colors: false,
    customInspect: true,
    showProxy: false,
    maxArrayLength: 100,
    maxStringLength: 10000,
    breakLength: 80,
    compact: 3,
    sorted: false,
    getters: false,
    numericSeparator: false,
    ...rest,
  };
}

// Saved before guest code runs, as Node's primordials are.
const functionToString = Function.prototype.toString;
const objectToString = Object.prototype.toString;
const hasOwn = Object.prototype.hasOwnProperty;
const isEnumerable = Object.prototype.propertyIsEnumerable;
const errorToString = Error.prototype.toString;
const regExpToString = RegExp.prototype.toString;
const dateToString = Date.prototype.toString;
const dateToUTCString = Date.prototype.toUTCString;

type GuestFunction = (...args: unknown[]) => unknown;
export type FunctionKind =
  | 'Function'
  | 'AsyncFunction'
  | 'GeneratorFunction'
  | 'AsyncGeneratorFunction';

/**
 * The kind of a function the engine compiled from source, read from the first
 * tokens of its source text: what Node reads from the function's internal slots.
 * Built-in, bound and proxied functions have native-code text and are plain
 * functions here (Node describes a proxy's target; not covered).
 */
function sourceKind(source: string): FunctionKind {
  try {
    const tokens = tokenizer(source, { ecmaVersion: 'latest' });
    const next = () => tokens.getToken();
    const first = next();
    if (first.type.keyword === 'function')
      return next().type.label === '*' ? 'GeneratorFunction' : 'Function';
    if (first.type.label === '*') return 'GeneratorFunction';
    // Compared as written: an escaped `async` is an identifier, not the keyword.
    if (first.type.label !== 'name' || source.slice(first.start, first.end) !== 'async')
      return 'Function';
    const second = next();
    if (second.type.keyword === 'function')
      return next().type.label === '*' ? 'AsyncGeneratorFunction' : 'AsyncFunction';
    if (second.type.label === '*') return 'AsyncGeneratorFunction';
    // `async => value` is an arrow whose parameter is named async.
    if (second.type.label === '=>') return 'Function';
    if (second.type.label === '(') {
      // An async arrow's parameter list is followed by `=>`; a method named
      // async has its body there.
      for (let depth = 1; depth > 0; ) {
        const token = next();
        if (token.type.label === 'eof') return 'Function';
        if (token.type.label === '(') depth++;
        else if (token.type.label === ')') depth--;
      }
      return next().type.label === '=>' ? 'AsyncFunction' : 'Function';
    }
    // `async x => x`, or an async method: `async name() {}`, `async [key]() {}`.
    return 'AsyncFunction';
  } catch {
    return 'Function';
  }
}

let loweredKind: (value: GuestFunction) => FunctionKind | undefined = () => undefined;

/**
 * Experimental async context compiles async functions to ordinary ones before
 * they run; the process tells inspect how to recognize the ones it marked.
 */
export function setLoweredFunctionKind(kind: (value: GuestFunction) => FunctionKind | undefined) {
  loweredKind = kind;
}

/**
 * What Node's internal slots say a function is: util.types and util.inspect
 * both answer from this.
 */
export function functionKind(value: unknown): FunctionKind | undefined {
  if (typeof value !== 'function') return undefined;
  let lowered: FunctionKind | undefined;
  try {
    lowered = loweredKind(value as GuestFunction);
  } catch {
    // Node's answer never throws.
  }
  return lowered ?? sourceKind(Reflect.apply(functionToString, value, []) as string);
}

// Node's getConstructorName for a function: the nearest prototype with an own
// named `constructor` the function is an instance of; null for a null prototype.
function constructorName(value: GuestFunction): string | null {
  let current: object | null = value;
  let first: object | null | undefined;
  while (current) {
    if (current === Function.prototype && value instanceof Function) return 'Function';
    if (current === Object.prototype && value instanceof Object) return 'Object';
    const ctor: unknown = Object.getOwnPropertyDescriptor(current, 'constructor')?.value;
    if (typeof ctor === 'function' && ctor.name !== '') {
      let instance = false;
      try {
        instance = value instanceof ctor;
      } catch {
        // Node's isInstanceof treats a throwing check as false.
      }
      if (instance) return String(ctor.name);
    }
    current = Object.getPrototypeOf(current) as object | null;
    if (first === undefined) first = current;
  }
  // Not covered: Node's `<Complex prototype>` description of a chain with no
  // usable constructor.
  return first === null ? null : 'Function';
}

const classPattern = /^(\s+[^(]*?)\s*{/;
const stripComments = /(\/\/.*?\n)|(\/\*(.|\n)*?\*\/)/g;

/** Node's getFunctionBase and getClassBase. */
function functionBase(ctx: Context, value: GuestFunction): string {
  const ctorName = constructorName(value);
  let tag: unknown = (value as unknown as Record<symbol, unknown>)[Symbol.toStringTag];
  // Node lists the tag only when it is not printed as a property.
  if (
    typeof tag !== 'string' ||
    (tag !== '' &&
      Reflect.apply(ctx.showHidden ? hasOwn : isEnumerable, value, [Symbol.toStringTag]) === true)
  )
    tag = '';
  const source = Reflect.apply(functionToString, value, []) as string;
  if (source.startsWith('class') && source.endsWith('}')) {
    const slice = source.slice(5, -1);
    const bracket = slice.indexOf('{');
    if (
      bracket !== -1 &&
      (!slice.slice(0, bracket).includes('(') ||
        classPattern.exec(slice.replace(stripComments, '')) !== null)
    ) {
      const name = (Reflect.apply(hasOwn, value, ['name']) === true && value.name) || '(anonymous)';
      let base = `class ${name}`;
      if (ctorName !== 'Function' && ctorName !== null) base += ` [${ctorName}]`;
      if (tag !== '' && ctorName !== tag) base += ` [${tag as string}]`;
      if (ctorName !== null) {
        const superName: unknown = (Object.getPrototypeOf(value) as { name?: unknown }).name;
        if (superName) base += ` extends ${String(superName)}`;
      } else base += ' extends [null prototype]';
      return `[${base}]`;
    }
  }
  const type = functionKind(value)!;
  let base = `[${type}`;
  if (ctorName === null) base += ' (null prototype)';
  const name: unknown = value.name;
  if (name === '') base += ' (anonymous)';
  else base += `: ${typeof name === 'string' ? name : formatValue(ctx, name, 0)}`;
  base += ']';
  if (ctorName !== type && ctorName !== null) base += ` ${ctorName}`;
  if (tag !== '' && ctorName !== tag) base += ` [${tag as string}]`;
  return base;
}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;
const isRegExp = (value: unknown) =>
  isObject(value) && Reflect.apply(objectToString, value, []) === '[object RegExp]';
const isDate = (value: unknown) =>
  isObject(value) && Reflect.apply(objectToString, value, []) === '[object Date]';
const isError = (value: unknown) =>
  isObject(value) &&
  (Reflect.apply(objectToString, value, []) === '[object Error]' || value instanceof Error);
const owns = (value: object, key: string) => Reflect.apply(hasOwn, value, [key]) === true;

function stylizeNoColor(text: string) {
  return text;
}

function stylizeWithColor(text: string, styleType: string) {
  // Read live, as the package does, so a guest can restyle util.inspect.
  const style = (inspect.styles as Record<string, string | undefined>)[styleType];
  if (!style) return text;
  const codes = (inspect.colors as Record<string, [number, number]>)[style];
  return `\u001b[${codes[0]}m${text}\u001b[${codes[1]}m`;
}

function formatPrimitive(ctx: Context, value: unknown): string | undefined {
  if (value === undefined) return ctx.stylize('undefined', 'undefined');
  if (typeof value === 'string') {
    const simple =
      "'" +
      JSON.stringify(value).replace(/^"|"$/g, '').replace(/'/g, "\\'").replace(/\\"/g, '"') +
      "'";
    return ctx.stylize(simple, 'string');
  }
  if (typeof value === 'number') return ctx.stylize('' + value, 'number');
  if (typeof value === 'boolean') return ctx.stylize('' + value, 'boolean');
  if (value === null) return ctx.stylize('null', 'null');
  return undefined;
}

const formatError = (value: object) =>
  '[' + (Reflect.apply(errorToString, value, []) as string) + ']';

/** The value's own hook, called by Node's convention; undefined when there is none. */
function customHook(ctx: Context, value: unknown, recurseTimes: number | null) {
  // A prototype object is not asked, as in the package and Node.
  const ctor = (value as { constructor?: { prototype?: unknown } }).constructor;
  if (ctor && ctor.prototype === value) return undefined;
  const legacy: unknown = (value as { inspect?: unknown }).inspect;
  if (typeof legacy === 'function' && legacy !== packageInspect && legacy !== inspect)
    return { result: Reflect.apply(legacy, value, [recurseTimes, ctx]) as unknown };
  const hook: unknown = (value as Record<symbol, unknown>)[custom];
  if (typeof hook !== 'function' || hook === inspect) return undefined;
  // Node reports the user's options and the depth left.
  const options = userOptions(ctx);
  const result: unknown = Reflect.apply(hook, value, [recurseTimes, options, inspect]);
  // Node formats the object itself when the hook returns it.
  if (result === value) return { result: inspect(value, { ...options, customInspect: false }) };
  return { result };
}

function formatValue(ctx: Context, value: unknown, recurseTimes: number | null): string {
  if (ctx.customInspect && value) {
    const hooked = customHook(ctx, value, recurseTimes);
    if (hooked) {
      const { result } = hooked;
      return typeof result === 'string' ? result : formatValue(ctx, result, recurseTimes);
    }
  }

  const primitive = formatPrimitive(ctx, value);
  if (primitive !== undefined) return primitive;
  // Only objects, functions and nested symbols reach here.
  const object = Object(value) as object;

  let keys = Object.keys(object);
  const visibleKeys = new Set(keys);
  if (ctx.showHidden) keys = Object.getOwnPropertyNames(object);

  if (isError(object) && (keys.includes('message') || keys.includes('description')))
    return formatError(object);

  if (typeof value === 'function') {
    const base = functionBase(ctx, value as GuestFunction);
    if (keys.length === 0) return ctx.stylize(base, 'special');
    // Past the depth limit Node names the constructor, as for any object.
    if (recurseTimes !== null && recurseTimes < 0)
      return ctx.stylize(`[${constructorName(value as GuestFunction) ?? 'Function'}]`, 'special');
    ctx.seen.push(value);
    const output = keys.map((key) =>
      formatProperty(ctx, object, recurseTimes, visibleKeys, key, false),
    );
    ctx.seen.pop();
    return `${base} ${reduceToSingleString(output, '', ['{', '}'])}`;
  }

  if (keys.length === 0) {
    if (isRegExp(object)) return ctx.stylize(Reflect.apply(regExpToString, object, []), 'regexp');
    if (isDate(object)) return ctx.stylize(Reflect.apply(dateToString, object, []), 'date');
    if (isError(object)) return formatError(object);
  }

  let base = '';
  let array = false;
  let braces: [string, string] = ['{', '}'];
  if (Array.isArray(object)) {
    array = true;
    braces = ['[', ']'];
  }
  if (isRegExp(object)) base = ' ' + (Reflect.apply(regExpToString, object, []) as string);
  if (isDate(object)) base = ' ' + (Reflect.apply(dateToUTCString, object, []) as string);
  if (isError(object)) base = ' ' + formatError(object);

  if (keys.length === 0 && (!array || (object as unknown[]).length === 0))
    return braces[0] + base + braces[1];

  if (recurseTimes !== null && recurseTimes < 0) {
    if (isRegExp(object)) return ctx.stylize(Reflect.apply(regExpToString, object, []), 'regexp');
    return ctx.stylize('[Object]', 'special');
  }

  ctx.seen.push(value);
  const output = array
    ? formatArray(ctx, object as unknown[], recurseTimes, visibleKeys, keys)
    : keys.map((key) => formatProperty(ctx, object, recurseTimes, visibleKeys, key, array));
  ctx.seen.pop();
  return reduceToSingleString(output, base, braces);
}

function formatArray(
  ctx: Context,
  value: unknown[],
  recurseTimes: number | null,
  visibleKeys: Set<string>,
  keys: string[],
) {
  const output: string[] = [];
  for (let i = 0, l = value.length; i < l; ++i) {
    if (owns(value, String(i)))
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys, String(i), true));
    else output.push('');
  }
  for (const key of keys)
    if (!/^\d+$/.test(key))
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys, key, true));
  return output;
}

function formatProperty(
  ctx: Context,
  value: object,
  recurseTimes: number | null,
  visibleKeys: Set<string>,
  key: string,
  array: boolean,
) {
  let name: string | undefined;
  let str: string | undefined;
  const desc = Object.getOwnPropertyDescriptor(value, key) ?? {
    value: (value as Record<string, unknown>)[key],
  };
  if (desc.get) str = ctx.stylize(desc.set ? '[Getter/Setter]' : '[Getter]', 'special');
  else if (desc.set) str = ctx.stylize('[Setter]', 'special');
  if (!visibleKeys.has(key)) name = '[' + key + ']';
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      str = formatValue(ctx, desc.value, recurseTimes === null ? null : recurseTimes - 1);
      if (str.includes('\n')) {
        str = array
          ? str
              .split('\n')
              .map((line) => '  ' + line)
              .join('\n')
              .slice(2)
          : '\n' +
            str
              .split('\n')
              .map((line) => '   ' + line)
              .join('\n');
      }
    } else str = ctx.stylize('[Circular]', 'special');
  }
  // Node quotes an own __proto__ key, hidden or not, so it does not read as the
  // prototype (formatProperty in lib/internal/util/inspect.js).
  if (key === '__proto__') return "['__proto__']: " + str;
  if (name === undefined) {
    if (array && /^\d+$/.test(key)) return str;
    name = JSON.stringify('' + key);
    if (/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/.test(name)) name = ctx.stylize(name.slice(1, -1), 'name');
    else
      name = ctx.stylize(
        name
          .replace(/'/g, "\\'")
          .replace(/\\"/g, '"')
          .replace(/(^"|"$)/g, "'"),
        'string',
      );
  }
  return name + ': ' + str;
}

function reduceToSingleString(output: string[], base: string, braces: [string, string]) {
  const length = output.reduce(
    (previous, current) => previous + current.replace(/\u001b\[\d\d?m/g, '').length + 1,
    0,
  );
  if (length > 60)
    return (
      braces[0] + (base === '' ? '' : base + '\n ') + ' ' + output.join(',\n  ') + ' ' + braces[1]
    );
  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}

export const inspect = Object.assign(
  function inspect(value?: unknown, options?: unknown) {
    // The package prints a symbol as `{}`; Node prints its description.
    if (typeof value === 'symbol') return value.toString();
    const ctx: Context = { seen: [], stylize: stylizeNoColor };
    // Legacy positional form: (value, showHidden, depth, colors).
    // eslint-disable-next-line prefer-rest-params -- a rest parameter would change inspect.length
    if (arguments.length >= 3) ctx.depth = arguments[2];
    // eslint-disable-next-line prefer-rest-params -- as above
    if (arguments.length >= 4) ctx.colors = arguments[3];
    if (typeof options === 'boolean') ctx.showHidden = options;
    else if (isObject(options))
      for (const key of Object.keys(options)) ctx[key] = (options as Record<string, unknown>)[key];
    if (ctx.showHidden === undefined) ctx.showHidden = false;
    if (ctx.depth === undefined) ctx.depth = 2;
    if (ctx.colors === undefined) ctx.colors = false;
    if (ctx.customInspect === undefined) ctx.customInspect = true;
    if (ctx.colors) ctx.stylize = stylizeWithColor;
    return formatValue(ctx, value, ctx.depth as number | null);
  },
  packageInspect,
  { custom },
);
// The bundler may rename the function; its name is observable.
Object.defineProperty(inspect, 'name', { value: 'inspect' });

/** util.parseEnv: a plain object of the `.env` text's variables (lib/util.js parseEnv). */
function parseEnv(content: unknown): Record<string, string> {
  if (typeof content !== 'string') throw invalidArgType('content', 'of type string', content);
  const result: Record<string, string> = {};
  // Node's dotenv store is a std::map, so keys arrive in byte order, which is code
  // point order. Plain assignment, as the binding's Set: `__proto__` is not a key.
  const sorted = [...parseDotenv(content)].sort(([a], [b]) => {
    const left = Array.from(a);
    const right = Array.from(b);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const delta = (left[i].codePointAt(0) ?? 0) - (right[i].codePointAt(0) ?? 0);
      if (delta !== 0) return delta;
    }
    return left.length - right.length;
  });
  for (const [key, value] of sorted) result[key] = value;
  return result;
}
// Bundling may rename the function; the name is observable.
Object.defineProperty(parseEnv, 'name', { value: 'parseEnv' });
export { parseEnv };
