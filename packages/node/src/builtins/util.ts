import { MIMEParams, MIMEType } from 'internal/nodelib/mime';
import { isDeepStrictEqual as internalDeepEqual } from 'internal/nodelib/util/comparisons';
import { diff } from 'internal/nodelib/util/diff';
import {
  format,
  formatWithOptions,
  inspect,
  stripVTControlCharacters,
} from 'internal/nodelib/util/inspect';
import { parseArgs } from 'internal/nodelib/util/parse_args/parse_args';
import { registerErrorInspect } from '../node-internal/errors';
import { setGuestProcess } from '../node-internal/process-ref';
import { type UtilHelperProcess, createUtilHelpers } from '../node-internal/util-helpers';
import { utilTypes } from '../node-internal/util/types';
import { parseEnv as parseUtilEnv } from '../util-inspect';
import { createDeprecate, createPromisify } from '../util-promisify';
import { createStyleText } from '../util-style-text';

export interface UtilBuiltinDeps {
  process: UtilHelperProcess & {
    argv: string[];
    execArgv: string[];
    stdout: ReturnType<Parameters<typeof createStyleText>[0]>;
    env: ReturnType<Parameters<typeof createStyleText>[1]>;
  };
}

const DEFAULT_INSPECT_OPTIONS: Readonly<Record<string, unknown>> = Object.freeze({
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
});

export function createUtilBuiltins(process: UtilBuiltinDeps['process']) {
  setGuestProcess(process);
  registerErrorInspect(inspect, format);
  Object.assign(inspect.defaultOptions, DEFAULT_INSPECT_OPTIONS);

  const helpers = createUtilHelpers(process);

  for (const [fn, name] of [
    [MIMEParams, 'MIMEParams'],
    [MIMEType, 'MIMEType'],
    [diff, 'diff'],
    [format, 'format'],
    [formatWithOptions, 'formatWithOptions'],
    [inspect, 'inspect'],
    [parseArgs, 'parseArgs'],
    [stripVTControlCharacters, 'stripVTControlCharacters'],
    [helpers.aborted, 'aborted'],
    [helpers.transferableAbortController, 'transferableAbortController'],
    [helpers.transferableAbortSignal, 'transferableAbortSignal'],
  ] as const) {
    if (fn.name !== name) {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
    }
  }

  return {
    'util/types': utilTypes,
    util: {
      ...helpers,
      MIMEParams,
      MIMEType,
      TextDecoder,
      TextEncoder,
      deprecate: createDeprecate(() => process),
      diff,
      format,
      formatWithOptions,
      inspect,
      isDeepStrictEqual(a: unknown, b: unknown): boolean {
        return internalDeepEqual(a, b);
      },
      parseArgs,
      parseEnv: parseUtilEnv,
      promisify: createPromisify(() => process),
      stripVTControlCharacters,
      styleText: createStyleText(
        () => process.stdout,
        () => process.env,
      ),
      // Node: StringPrototypeToWellFormed(`${str}`); a Symbol throws TypeError.
      toUSVString: (value: unknown) =>
        // The compiler lib predates String.prototype.toWellFormed; Chromium has it.
        (`${value as string}` as string & { toWellFormed(): string }).toWellFormed(),
      types: utilTypes,
    },
  };
}
