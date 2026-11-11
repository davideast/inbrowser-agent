import stripAnsi from 'strip-ansi';
import { record } from './protocol';
import { inspect } from './util-inspect';

export function stripVTControlCharacters(value: unknown): string {
  if (typeof value !== 'string')
    throw Object.assign(new TypeError('str must be a string'), { code: 'ERR_INVALID_ARG_TYPE' });
  return stripAnsi(value);
}

const numberText = (value: number) => (Object.is(value, -0) ? '-0' : String(value));

export function formatWithOptions(options: unknown, ...args: unknown[]): string {
  if (!record(options))
    throw Object.assign(new TypeError('inspectOptions must be an object'), {
      code: 'ERR_INVALID_ARG_TYPE',
    });
  const display = (value: unknown) => (typeof value === 'string' ? value : inspect(value, options));
  const first = args[0];
  if (typeof first !== 'string') return args.map(display).join(' ');
  if (args.length === 1) return first;
  let next = 1;
  const formatted = first.replace(/%[sdifjoOc%]/g, (token) => {
    if (token === '%%') return '%';
    if (next >= args.length) return token;
    const value = args[next++];
    switch (token) {
      case '%s':
        if (typeof value === 'bigint') return `${value}n`;
        if (
          value !== null &&
          typeof value === 'object' &&
          (value.toString === Object.prototype.toString ||
            value.toString === Array.prototype.toString ||
            typeof value.toString !== 'function')
        ) {
          const text = inspect(value, { ...options, depth: 0, colors: false });
          return Object.getPrototypeOf(value) === null ? `[Object: null prototype] ${text}` : text;
        }
        return String(value);
      case '%d':
      case '%i':
        if (typeof value === 'bigint') return `${value}n`;
        if (typeof value === 'symbol') return 'NaN';
        return numberText(token === '%d' ? Number(value) : Number.parseInt(String(value), 10));
      case '%f':
        return typeof value === 'symbol' ? 'NaN' : numberText(Number.parseFloat(String(value)));
      case '%j':
        try {
          return String(JSON.stringify(value));
        } catch (error) {
          // Engines have different text for the JSON cycle error. Other errors,
          // including BigInt and user toJSON failures, must still propagate.
          if (
            error instanceof TypeError &&
            /^(Converting circular structure to JSON|cyclic object value)/.test(error.message)
          )
            return '[Circular]';
          throw error;
        }
      case '%o':
        return inspect(value, { ...options, showHidden: true, depth: 4 });
      case '%O':
        return inspect(value, options);
      case '%c':
        return '';
      default:
        return token;
    }
  });
  return [formatted, ...args.slice(next).map(display)].join(' ');
}
