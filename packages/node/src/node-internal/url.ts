// Browser-safe `internal/url` helpers + Node 22.18 URL/URLSearchParams custom inspect.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { pathToFileURL as basePathToFileURL, fileURLToPath } from '../file-url';
import { stripVTControlCharacters } from '../util-format';
import { codes } from './errors';
import { activeProcess } from './process-ref';

const LocalURL = globalThis.URL;
const LocalURLSearchParams = globalThis.URLSearchParams;
const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');

interface InspectOpts {
  depth?: number | null;
  breakLength?: number;
  stylize?: (text: string, styleType: string) => string;
  [key: string]: unknown;
}

type InspectFn = (value: unknown, opts?: InspectOpts) => string;

function getConstructorOf(obj: unknown): (abstract new (...args: never[]) => unknown) | null {
  let cur: unknown = obj;
  while (cur !== null && typeof cur === 'object') {
    const desc = Object.getOwnPropertyDescriptor(cur, 'constructor');
    if (desc !== undefined && typeof desc.value === 'function' && desc.value.name !== '') {
      // Invariant: narrowed above via `typeof desc.value === 'function'`.
      return desc.value as abstract new (
        ...args: never[]
      ) => unknown;
    }
    cur = Object.getPrototypeOf(cur);
  }
  return null;
}

if (
  typeof LocalURL === 'function' &&
  !Object.prototype.hasOwnProperty.call(LocalURL.prototype, customInspectSymbol)
) {
  const urlInspect = {
    [customInspectSymbol](
      this: URL,
      depth: unknown,
      opts: InspectOpts,
      ...rest: [InspectFn?]
    ): unknown {
      if (!(this instanceof LocalURL)) {
        throw new codes.ERR_INVALID_THIS('URL');
      }
      if (typeof depth === 'number' && depth < 0) return this;
      const inspectFn = rest[0];
      if (typeof inspectFn !== 'function') return this.href;

      const ctor = getConstructorOf(this) ?? LocalURL;
      const obj = Object.setPrototypeOf(
        {
          href: this.href,
          origin: this.origin,
          protocol: this.protocol,
          username: this.username,
          password: this.password,
          host: this.host,
          hostname: this.hostname,
          port: this.port,
          pathname: this.pathname,
          search: this.search,
          searchParams: this.searchParams,
          hash: this.hash,
        },
        { constructor: ctor },
      );
      return `${ctor.name} ${inspectFn(obj, opts)}`;
    },
  }[customInspectSymbol];

  Object.defineProperty(LocalURL.prototype, customInspectSymbol, {
    value: urlInspect,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

if (
  typeof LocalURLSearchParams === 'function' &&
  !Object.prototype.hasOwnProperty.call(LocalURLSearchParams.prototype, customInspectSymbol)
) {
  const paramsInspect = {
    [customInspectSymbol](
      this: URLSearchParams,
      recurseTimes: unknown,
      ctx: InspectOpts,
      ...rest: [InspectFn?]
    ): string {
      if (!(this instanceof LocalURLSearchParams)) {
        throw new codes.ERR_INVALID_THIS('URLSearchParams');
      }
      if (typeof recurseTimes === 'number' && recurseTimes < 0) {
        return typeof ctx?.stylize === 'function' ? ctx.stylize('[Object]', 'special') : '[Object]';
      }
      const inspectFn = rest[0];
      if (typeof inspectFn !== 'function') return this.toString();

      const separator = ', ';
      const innerOpts: InspectOpts = { ...ctx };
      if (recurseTimes !== null && typeof recurseTimes === 'number') {
        innerOpts.depth = recurseTimes - 1;
      }
      const output: string[] = [];
      for (const [k, v] of LocalURLSearchParams.prototype.entries.call(this)) {
        output.push(`${inspectFn(k, innerOpts)} => ${inspectFn(v, innerOpts)}`);
      }
      const length = output.reduce(
        (prev, cur) => prev + stripVTControlCharacters(cur).length + separator.length,
        -separator.length,
      );
      const ctor: unknown = Reflect.get(this, 'constructor');
      const ctorName = typeof ctor === 'function' && ctor.name ? ctor.name : 'URLSearchParams';
      if (length > (ctx.breakLength ?? 80)) {
        return `${ctorName} {\n  ${output.join(',\n  ')} }`;
      }
      if (output.length > 0) {
        return `${ctorName} { ${output.join(separator)} }`;
      }
      return `${ctorName} {}`;
    },
  }[customInspectSymbol];

  Object.defineProperty(LocalURLSearchParams.prototype, customInspectSymbol, {
    value: paramsInspect,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

export { LocalURL as URL, LocalURLSearchParams as URLSearchParams, fileURLToPath };

export function pathToFileURL(filepath: string): URL {
  const proc = activeProcess();
  const cwd = typeof proc.cwd === 'function' ? String(proc.cwd()) : '/';
  return basePathToFileURL(filepath, cwd);
}

export function isURL(self: unknown): self is URL {
  return self instanceof LocalURL;
}
