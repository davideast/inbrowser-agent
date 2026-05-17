/**
 * Schema-driven arg parser. Inputs flow through `hardenString`/`hardenPath`
 * per the rules declared in `spec.ts` — there is no second source of
 * truth. Returns a typed `ParsedArgs` or throws `InputHardeningError`
 * (already structured for NDJSON emission).
 */

import { hardenPath, hardenString, InputHardeningError } from './hardening.js';
import type { CommandSpec, OptionSpec } from './spec.js';
import { CLI_SPEC, findCommand } from './spec.js';

export interface ParsedArgs {
  command: string;
  options: Record<string, string | number | boolean | string[]>;
  positional: string[];
  /** Original argv minus the parsed command, useful for diagnostics. */
  remainder: string[];
}

export class UsageError extends Error {
  override readonly name = 'UsageError';
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

function optionByFlag(flags: string, cmd: CommandSpec | undefined): OptionSpec | undefined {
  const all: OptionSpec[] = [...CLI_SPEC.globalOptions, ...(cmd?.options ?? [])];
  return all.find((o) => o.name === flags || o.short === flags);
}

function coerceValue(spec: OptionSpec, raw: string | true, field: string, cwd: string): string | number | boolean | string[] {
  if (spec.type === 'boolean') return raw === true ? true : raw !== 'false';
  if (raw === true) {
    throw new UsageError(`${field} requires a value`, `Pass it as --${spec.name.replace(/^--/, '')} <value>`);
  }
  switch (spec.type) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new UsageError(`${field} expects a number, got ${JSON.stringify(raw)}`);
      return n;
    }
    case 'enum': {
      if (!spec.choices?.includes(raw)) {
        throw new UsageError(
          `${field} expects one of ${spec.choices?.join(', ')}; got ${JSON.stringify(raw)}`,
        );
      }
      return raw;
    }
    case 'string[]': {
      const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const item of items) {
        if (spec.validate) hardenString(field, item, spec.validate);
      }
      return items;
    }
    case 'path': {
      return hardenPath(field, raw, spec.validate ?? {}, cwd);
    }
    case 'json': {
      // The literal value here is either '-' (stdin sentinel) or a file path.
      // Hardening for path-likeness applies, but we don't *resolve* — the
      // command handler decides whether to read stdin or open a file.
      if (raw === '-') return '-';
      return hardenPath(field, raw, { rejectControlChars: true, rejectQueryChars: true, maxLength: 1024 }, cwd);
    }
    case 'string':
    default: {
      if (spec.validate) hardenString(field, raw, spec.validate);
      return raw;
    }
  }
}

/**
 * Parse argv into `{command, options, positional}`. The first
 * non-option token is the command. Unknown flags throw `UsageError`.
 */
export function parseArgs(argv: readonly string[], cwd: string = process.cwd()): ParsedArgs {
  if (argv.length === 0) {
    return { command: 'help', options: {}, positional: [], remainder: [] };
  }

  // First positional is the command. Allow `agent --help` and `agent -h` as shortcuts to help.
  let commandName = '';
  let cursor = 0;
  while (cursor < argv.length) {
    const tok = argv[cursor]!;
    if (tok === '--help' || tok === '-h') {
      commandName = 'help';
      cursor += 1;
      break;
    }
    if (tok === '--version' || tok === '-v') {
      commandName = 'version';
      cursor += 1;
      break;
    }
    if (!tok.startsWith('-')) {
      commandName = tok;
      cursor += 1;
      break;
    }
    // A leading global option before the command name is allowed; rewind.
    break;
  }
  if (!commandName) {
    commandName = 'help';
  }

  if (!findCommand(commandName) && commandName !== 'help') {
    throw new UsageError(
      `unknown command: ${commandName}`,
      `Try one of: ${CLI_SPEC.commands.map((c) => c.name).join(', ')}`,
    );
  }

  const cmd = findCommand(commandName);
  const options: Record<string, string | number | boolean | string[]> = {};
  const positional: string[] = [];

  while (cursor < argv.length) {
    const tok = argv[cursor]!;
    if (tok === '--') {
      positional.push(...argv.slice(cursor + 1));
      break;
    }
    if (!tok.startsWith('-')) {
      positional.push(tok);
      cursor += 1;
      continue;
    }

    // Support --name=value as well as --name value.
    let flag = tok;
    let inlineValue: string | undefined;
    const eq = tok.indexOf('=');
    if (eq > 0) {
      flag = tok.slice(0, eq);
      inlineValue = tok.slice(eq + 1);
    }

    const spec = optionByFlag(flag, cmd);
    if (!spec) {
      throw new UsageError(
        `unknown option ${flag} for "${commandName}"`,
        `Run \`agent describe --target commands\` to list valid options.`,
      );
    }

    const key = spec.name.replace(/^--/, '');
    if (spec.type === 'boolean') {
      options[key] = inlineValue ? inlineValue !== 'false' : true;
      cursor += 1;
      continue;
    }

    let raw: string | true;
    if (inlineValue !== undefined) {
      raw = inlineValue;
      cursor += 1;
    } else {
      const next = argv[cursor + 1];
      if (next === undefined) {
        raw = true;
        cursor += 1;
      } else {
        raw = next;
        cursor += 2;
      }
    }
    options[key] = coerceValue(spec, raw, flag, cwd);
  }

  return { command: commandName, options, positional, remainder: argv.slice(cursor) };
}

export { InputHardeningError };
