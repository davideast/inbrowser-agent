// util.parseArgs, ported from Node.js v22.18.0 lib/internal/util/parse_args/
// parse_args.js and utils.js. Copyright Node.js contributors. Released under the
// MIT license (see LICENSE in the Node.js repository). Changes: TypeScript types,
// Node's internal validators and error classes replaced by node-errors.ts, and
// getMainArgs reads the guest process passed to createParseArgs.
import { invalidArgType, invalidArgValue, nodeError } from './node-errors';

type Config = Record<string, unknown>;
interface Token {
  kind: 'option' | 'positional' | 'option-terminator';
  index: number;
  name?: string;
  rawName?: string;
  value?: string;
  inlineValue?: boolean;
}

const hasOwn = (object: object, property: string) =>
  Object.prototype.hasOwnProperty.call(object, property);

function objectGetOwn(object: unknown, property: string): unknown {
  if (hasOwn(object as object, property)) return (object as Config)[property];
  return undefined;
}

function optionsGetOwn(options: Config, longOption: string, property: string): unknown {
  if (hasOwn(options, longOption)) return objectGetOwn(options[longOption], property);
  return undefined;
}

const isOptionValue = (value: unknown) => value != null;

const isOptionLikeValue = (value: string | undefined) =>
  value != null && value.length > 1 && value.charAt(0) === '-';

const isLoneShortOption = (arg: string) =>
  arg.length === 2 && arg.charAt(0) === '-' && arg.charAt(1) !== '-';

const isLoneLongOption = (arg: string) =>
  arg.length > 2 && arg.startsWith('--') && !arg.includes('=', 3);

const isLongOptionAndValue = (arg: string) =>
  arg.length > 2 && arg.startsWith('--') && arg.includes('=', 3);

function validateObject(value: unknown, name: string) {
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw invalidArgType(name, 'Object', value);
}

function findLongOptionForShort(shortOption: string, options: Config): string {
  validateObject(options, 'options');
  const entry = Object.entries(options).find(
    ({ 1: optionConfig }) => objectGetOwn(optionConfig, 'short') === shortOption,
  );
  return entry?.[0] ?? shortOption;
}

function isShortOptionGroup(arg: string, options: Config): boolean {
  if (arg.length <= 2) return false;
  if (arg.charAt(0) !== '-') return false;
  if (arg.charAt(1) === '-') return false;
  const longOption = findLongOptionForShort(arg.charAt(1), options);
  return optionsGetOwn(options, longOption, 'type') !== 'string';
}

function isShortOptionAndValue(arg: string, options: Config): boolean {
  validateObject(options, 'options');
  if (arg.length <= 2) return false;
  if (arg.charAt(0) !== '-') return false;
  if (arg.charAt(1) === '-') return false;
  const longOption = findLongOptionForShort(arg.charAt(1), options);
  return optionsGetOwn(options, longOption, 'type') === 'string';
}

const parseError = (code: string, message: string) => nodeError(TypeError, code, message);

function unknownOption(option: string, allowPositionals: boolean) {
  const suggestDashDash = allowPositionals
    ? ". To specify a positional argument starting with a '-', place it at the end of the " +
      `command after '--', as in '-- ${JSON.stringify(option)}`
    : '';
  return parseError(
    'ERR_PARSE_ARGS_UNKNOWN_OPTION',
    `Unknown option '${option}'${suggestDashDash}`,
  );
}

function checkOptionLikeValue(token: Token) {
  if (!token.inlineValue && isOptionLikeValue(token.value)) {
    const example = token.rawName!.startsWith('--')
      ? `'${token.rawName}=-XYZ'`
      : `'--${token.name}=-XYZ' or '${token.rawName}-XYZ'`;
    throw parseError(
      'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
      `Option '${token.rawName}' argument is ambiguous.
Did you forget to specify the option argument for '${token.rawName}'?
To specify an option argument starting with a dash use ${example}.`,
    );
  }
}

interface ParseConfig {
  options: Config;
  allowPositionals: boolean;
  allowNegative: boolean;
}

function checkOptionUsage(config: ParseConfig, token: Token) {
  let tokenName = token.name!;
  if (!hasOwn(config.options, tokenName)) {
    if (config.allowNegative && tokenName.startsWith('no-')) {
      tokenName = tokenName.slice(3);
      if (
        !hasOwn(config.options, tokenName) ||
        optionsGetOwn(config.options, tokenName, 'type') !== 'boolean'
      )
        throw unknownOption(token.rawName!, config.allowPositionals);
    } else {
      throw unknownOption(token.rawName!, config.allowPositionals);
    }
  }
  const short = optionsGetOwn(config.options, tokenName, 'short');
  const shortAndLong = `${short ? `-${short}, ` : ''}--${tokenName}`;
  const type = optionsGetOwn(config.options, tokenName, 'type');
  if (type === 'string' && typeof token.value !== 'string')
    throw parseError(
      'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
      `Option '${shortAndLong} <value>' argument missing`,
    );
  if (type === 'boolean' && token.value != null)
    throw parseError(
      'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
      `Option '${shortAndLong}' does not take an argument`,
    );
}

function storeOption(
  token: Token,
  options: Config,
  values: Record<string, unknown>,
  allowNegative: boolean,
) {
  let longOption = token.name!;
  let optionValue: string | boolean | undefined = token.value;
  if (longOption === '__proto__') return;
  if (allowNegative && longOption.startsWith('no-') && optionValue === undefined) {
    longOption = longOption.slice(3);
    token.name = longOption;
    optionValue = false;
  }
  const newValue = optionValue ?? true;
  if (optionsGetOwn(options, longOption, 'multiple')) {
    const existing = values[longOption];
    if (existing) (existing as unknown[]).push(newValue);
    else values[longOption] = [newValue];
  } else {
    values[longOption] = newValue;
  }
}

function argsToTokens(args: string[], options: Config): Token[] {
  const tokens: Token[] = [];
  let index = -1;
  let groupCount = 0;
  const remainingArgs = args.slice();
  while (remainingArgs.length > 0) {
    const arg = remainingArgs.shift()!;
    const nextArg = remainingArgs[0];
    if (groupCount > 0) groupCount--;
    else index++;

    if (arg === '--') {
      tokens.push({ kind: 'option-terminator', index });
      tokens.push(
        ...remainingArgs.map((value) => ({ kind: 'positional' as const, index: ++index, value })),
      );
      break;
    }

    if (isLoneShortOption(arg)) {
      const shortOption = arg.charAt(1);
      const longOption = findLongOptionForShort(shortOption, options);
      let value: string | undefined;
      let inlineValue: boolean | undefined;
      if (optionsGetOwn(options, longOption, 'type') === 'string' && isOptionValue(nextArg)) {
        value = remainingArgs.shift();
        inlineValue = false;
      }
      tokens.push({ kind: 'option', name: longOption, rawName: arg, index, value, inlineValue });
      if (value != null) ++index;
      continue;
    }

    if (isShortOptionGroup(arg, options)) {
      const expanded: string[] = [];
      for (let position = 1; position < arg.length; position++) {
        const shortOption = arg.charAt(position);
        const longOption = findLongOptionForShort(shortOption, options);
        if (
          optionsGetOwn(options, longOption, 'type') !== 'string' ||
          position === arg.length - 1
        ) {
          expanded.push(`-${shortOption}`);
        } else {
          expanded.push(`-${arg.slice(position)}`);
          break;
        }
      }
      remainingArgs.unshift(...expanded);
      groupCount = expanded.length;
      continue;
    }

    if (isShortOptionAndValue(arg, options)) {
      const shortOption = arg.charAt(1);
      const longOption = findLongOptionForShort(shortOption, options);
      tokens.push({
        kind: 'option',
        name: longOption,
        rawName: `-${shortOption}`,
        index,
        value: arg.slice(2),
        inlineValue: true,
      });
      continue;
    }

    if (isLoneLongOption(arg)) {
      const longOption = arg.slice(2);
      let value: string | undefined;
      let inlineValue: boolean | undefined;
      if (optionsGetOwn(options, longOption, 'type') === 'string' && isOptionValue(nextArg)) {
        value = remainingArgs.shift();
        inlineValue = false;
      }
      tokens.push({ kind: 'option', name: longOption, rawName: arg, index, value, inlineValue });
      if (value != null) ++index;
      continue;
    }

    if (isLongOptionAndValue(arg)) {
      const equalIndex = arg.indexOf('=');
      const longOption = arg.slice(2, equalIndex);
      tokens.push({
        kind: 'option',
        name: longOption,
        rawName: `--${longOption}`,
        index,
        value: arg.slice(equalIndex + 1),
        inlineValue: true,
      });
      continue;
    }

    tokens.push({ kind: 'positional', index, value: arg });
  }
  return tokens;
}

function validateDefault(optionType: unknown, multiple: unknown, value: unknown, name: string) {
  const expected = optionType === 'string' ? 'string' : 'boolean';
  const valid = (item: unknown) =>
    expected === 'string' ? typeof item === 'string' : item === true || item === false;
  if (!multiple) {
    if (!valid(value)) throw invalidArgType(name, expected, value);
    return;
  }
  if (!Array.isArray(value)) throw invalidArgType(name, 'Array', value);
  for (let i = 0; i < value.length; ++i)
    if (!valid(value[i])) throw invalidArgType(`${name}[${i}]`, expected, value[i]);
}

/** Builds util.parseArgs bound to the guest process (for the default `args`). */
export function createParseArgs(guestProcess: { argv: string[]; execArgv: string[] }) {
  function getMainArgs(): string[] {
    const { execArgv } = guestProcess;
    if (
      execArgv.includes('-e') ||
      execArgv.includes('--eval') ||
      execArgv.includes('-p') ||
      execArgv.includes('--print')
    )
      return guestProcess.argv.slice(1);
    return guestProcess.argv.slice(2);
  }

  return function parseArgs(config: Config = Object.create(null) as Config) {
    const args = (objectGetOwn(config, 'args') ?? getMainArgs()) as string[];
    const strict = (objectGetOwn(config, 'strict') ?? true) as boolean;
    const allowPositionals = (objectGetOwn(config, 'allowPositionals') ?? !strict) as boolean;
    const returnTokens = (objectGetOwn(config, 'tokens') ?? false) as boolean;
    const allowNegative = (objectGetOwn(config, 'allowNegative') ?? false) as boolean;
    const options = (objectGetOwn(config, 'options') ?? Object.create(null)) as Config;
    const parseConfig: ParseConfig = { options, allowPositionals, allowNegative };

    if (!Array.isArray(args)) throw invalidArgType('args', 'Array', args);
    if (typeof strict !== 'boolean') throw invalidArgType('strict', 'boolean', strict);
    if (typeof allowPositionals !== 'boolean')
      throw invalidArgType('allowPositionals', 'boolean', allowPositionals);
    if (typeof returnTokens !== 'boolean') throw invalidArgType('tokens', 'boolean', returnTokens);
    if (typeof allowNegative !== 'boolean')
      throw invalidArgType('allowNegative', 'boolean', allowNegative);
    validateObject(options, 'options');
    for (const [longOption, optionConfig] of Object.entries(options)) {
      validateObject(optionConfig, `options.${longOption}`);
      const optionType = objectGetOwn(optionConfig, 'type');
      if (optionType !== 'string' && optionType !== 'boolean')
        throw invalidArgType(`options.${longOption}.type`, `('string|boolean')`, optionType);
      if (hasOwn(optionConfig as object, 'short')) {
        const shortOption = (optionConfig as Config).short;
        if (typeof shortOption !== 'string')
          throw invalidArgType(`options.${longOption}.short`, 'string', shortOption);
        if (shortOption.length !== 1)
          throw invalidArgValue(
            `options.${longOption}.short`,
            shortOption,
            'must be a single character',
          );
      }
      const multipleOption = objectGetOwn(optionConfig, 'multiple');
      if (hasOwn(optionConfig as object, 'multiple') && typeof multipleOption !== 'boolean')
        throw invalidArgType(`options.${longOption}.multiple`, 'boolean', multipleOption);
      const defaultValue = objectGetOwn(optionConfig, 'default');
      if (defaultValue !== undefined)
        validateDefault(optionType, multipleOption, defaultValue, `options.${longOption}.default`);
    }

    const tokens = argsToTokens(args, options);
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const result: { values: Record<string, unknown>; positionals: string[]; tokens?: Token[] } = {
      values,
      positionals: [],
    };
    if (returnTokens) result.tokens = tokens;
    for (const token of tokens) {
      if (token.kind === 'option') {
        if (strict) {
          checkOptionUsage(parseConfig, token);
          checkOptionLikeValue(token);
        }
        storeOption(token, options, values, allowNegative);
      } else if (token.kind === 'positional') {
        if (!allowPositionals)
          throw parseError(
            'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
            `Unexpected argument '${token.value}'. This command does not take positional arguments`,
          );
        result.positionals.push(token.value!);
      }
    }
    for (const [longOption, optionConfig] of Object.entries(options)) {
      if (objectGetOwn(optionConfig, 'default') !== undefined && values[longOption] === undefined) {
        if (longOption === '__proto__') continue;
        values[longOption] = objectGetOwn(optionConfig, 'default');
      }
    }
    return result;
  };
}
