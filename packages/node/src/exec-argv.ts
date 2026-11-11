import { fault } from './protocol';
import { resourceLimits } from './resource-policy';

const REJECTION_MODES = ['throw', 'strict', 'warn', 'none', 'warn-with-error-code'] as const;
export type UnhandledRejectionsMode = (typeof REJECTION_MODES)[number];
const REJECTION_FLAG = '--unhandled-rejections';

/**
 * Reads `--unhandled-rejections` at `tokens[index]`, joined by `=` or followed
 * by its value. Returns the value and the index of the last token consumed,
 * the message Node refuses to start with, or undefined for any other token.
 */
function rejectionFlag(
  tokens: string[],
  index: number,
): { value: string; last: number } | { problem: string } | undefined {
  const token = tokens[index];
  if (token === REJECTION_FLAG) {
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('-'))
      return { problem: `${REJECTION_FLAG} requires an argument` };
    return { value, last: index + 1 };
  }
  if (!token.startsWith(REJECTION_FLAG + '=')) return undefined;
  const value = token.slice(REJECTION_FLAG.length + 1);
  return value ? { value, last: index } : { problem: `${REJECTION_FLAG}= requires an argument` };
}

/** Node validates the last value given, so an earlier unknown one is harmless. */
function rejectionMode(value: string): UnhandledRejectionsMode | { problem: string } {
  return (
    REJECTION_MODES.find((mode) => mode === value) ?? {
      problem: `invalid value for ${REJECTION_FLAG}`,
    }
  );
}

/**
 * Node's NODE_OPTIONS splitting: spaces separate, `"` groups, a backslash
 * escapes inside quotes. A value Node cannot split is the message it exits with.
 */
function nodeOptionTokens(value: string): string[] | { problem: string } {
  const tokens: string[] = [];
  let quoted = false;
  let fresh = true;
  for (let index = 0; index < value.length; index++) {
    let character = value[index];
    if (character === '\\' && quoted) {
      if (index + 1 === value.length)
        return { problem: 'invalid value for NODE_OPTIONS (invalid escape)' };
      character = value[++index];
    } else if (character === ' ' && !quoted) {
      fresh = true;
      continue;
    } else if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (fresh) {
      tokens.push(character);
      fresh = false;
    } else tokens[tokens.length - 1] += character;
  }
  return quoted ? { problem: 'invalid value for NODE_OPTIONS (unterminated string)' } : tokens;
}

/**
 * The `--unhandled-rejections` mode named by NODE_OPTIONS, or the message Node
 * refuses to start with. Every other token is ignored: the variable is not a
 * general option channel in this runtime.
 */
export function nodeOptionsRejectionMode(value: unknown): {
  mode?: UnhandledRejectionsMode;
  problem?: string;
} {
  if (typeof value !== 'string') return {};
  const tokens = nodeOptionTokens(value);
  if (!Array.isArray(tokens)) return tokens;
  let named: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const flag = rejectionFlag(tokens, index);
    if (!flag) continue;
    if ('problem' in flag) return flag;
    named = flag.value;
    index = flag.last;
  }
  if (named === undefined) return {};
  const mode = rejectionMode(named);
  return typeof mode === 'string' ? { mode } : mode;
}

/** Parse the supported startup subset before any child resources or guest effects. */
export function parseExecArgv(value: unknown = []) {
  if (!Array.isArray(value)) throw fault('EINVAL', 'execArgv must be an array');
  if (value.length > resourceLimits().child.execArgvCount)
    throw fault('E2BIG', 'Too many startup arguments');
  const argv: string[] = [];
  let bytes = 0;
  for (const arg of value) {
    if (typeof arg !== 'string' || arg.includes('\0'))
      throw fault('EINVAL', 'Startup arguments must be strings without NUL');
    bytes += new TextEncoder().encode(arg).byteLength;
    if (bytes > resourceLimits().child.execArgvBytes)
      throw fault('E2BIG', 'Startup arguments exceed limit');
    argv.push(arg);
  }
  const preloads: string[] = [];
  const conditions: string[] = [];
  let importMetaResolve = false;
  let rejections: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const rejection = rejectionFlag(argv, index);
    if (rejection) {
      if ('problem' in rejection) throw fault('EINVAL', rejection.problem);
      rejections = rejection.value;
      index = rejection.last;
    } else if (Object.hasOwn(WARNING_FLAGS, flag)) continue;
    else if (flag === '--experimental-import-meta-resolve') importMetaResolve = true;
    else if (flag === '--require' || flag === '--conditions') {
      const argument = argv[++index];
      if (!argument) throw fault('EINVAL', `Missing argument for ${flag}`);
      (flag === '--require' ? preloads : conditions).push(argument);
    } else throw fault('ENOSYS', `Unsupported startup option ${flag}`);
  }
  const unhandledRejections = rejections === undefined ? undefined : rejectionMode(rejections);
  if (typeof unhandledRejections === 'object') throw fault('EINVAL', unhandledRejections.problem);
  return { argv, preloads, conditions, importMetaResolve, unhandledRejections };
}

/** The warning flags process.emitWarning and the `warning` reporter honor. */
const WARNING_FLAGS = {
  '--no-warnings': 'noWarnings',
  '--no-deprecation': 'noDeprecation',
  '--throw-deprecation': 'throwDeprecation',
  '--trace-warnings': 'traceWarnings',
  '--trace-deprecation': 'traceDeprecation',
} as const;
export type WarningFlags = Record<(typeof WARNING_FLAGS)[keyof typeof WARNING_FLAGS], boolean>;

/** Which warning flags a parsed `argv` (from parseExecArgv) gives. */
export function warningFlags(argv: readonly string[]): WarningFlags {
  const flags: WarningFlags = {
    noWarnings: false,
    noDeprecation: false,
    throwDeprecation: false,
    traceWarnings: false,
    traceDeprecation: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    // Skip the argument values parseExecArgv consumed, which are not flags.
    if (flag === '--require' || flag === '--conditions' || flag === REJECTION_FLAG) index++;
    // Checked as an own key of WARNING_FLAGS on the same line.
    else if (Object.hasOwn(WARNING_FLAGS, flag))
      flags[WARNING_FLAGS[flag as keyof typeof WARNING_FLAGS]] = true;
  }
  return flags;
}
