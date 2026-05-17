/**
 * `agent help` — render top-level help in text mode, or emit the full
 * schema (same as `agent schema`) in ndjson/json mode. Honors a
 * subcommand argument: `agent help run` scopes to one command.
 *
 * Per the Agent DX rubric: `--help --json` MUST give the machine-
 * readable description. We achieve that by deferring to the emitter
 * — if the caller passed --output json or stdout isn't a TTY, the
 * help payload is the JSON schema, not prose.
 */

import type { Emitter } from '../output.js';
import type { ParsedArgs } from '../parse.js';
import { CLI_SPEC, findCommand } from '../spec.js';

function renderTextHelp(commandName?: string): string {
  if (commandName) {
    const cmd = findCommand(commandName);
    if (!cmd) return `unknown command: ${commandName}`;
    const lines: string[] = [];
    lines.push(`agent ${cmd.name} — ${cmd.description}`);
    lines.push('');
    if (cmd.positional) lines.push(`Positional: <${cmd.positional.name}> — ${cmd.positional.description}`);
    if (cmd.options.length > 0) {
      lines.push('Options:');
      for (const o of cmd.options) {
        const flag = o.short ? `${o.name}, ${o.short}` : o.name;
        const dflt = o.default !== undefined ? ` (default: ${JSON.stringify(o.default)})` : '';
        lines.push(`  ${flag.padEnd(24)} ${o.description}${dflt}`);
      }
    }
    if (cmd.examples) {
      lines.push('');
      lines.push('Examples:');
      for (const e of cmd.examples) {
        lines.push(`  $ ${e.input}`);
        lines.push(`    ${e.description}`);
      }
    }
    return lines.join('\n');
  }

  const lines: string[] = [];
  lines.push(`${CLI_SPEC.name} v${CLI_SPEC.version} — ${CLI_SPEC.description}`);
  lines.push('');
  lines.push('Commands:');
  for (const c of CLI_SPEC.commands) {
    lines.push(`  ${c.name.padEnd(10)} ${c.description}`);
  }
  lines.push('');
  lines.push('Global options:');
  for (const o of CLI_SPEC.globalOptions) {
    const flag = o.short ? `${o.name}, ${o.short}` : o.name;
    lines.push(`  ${flag.padEnd(20)} ${o.description}`);
  }
  lines.push('');
  lines.push(
    'Agent integration tips:\n' +
      '  • Pipe-friendly: NDJSON is the default when stdout is not a TTY.\n' +
      '  • Discover the full schema with `agent schema` or `agent describe`.\n' +
      '  • Always validate with `--dry-run` before mutating commands.\n' +
      '  • Filter event fields with `--fields ts,type,sessionId,...` to save tokens.\n' +
      '  • See AGENTS.md for invariants.',
  );
  return lines.join('\n');
}

export function helpCommand(args: ParsedArgs, emit: Emitter): number {
  const subject = args.positional[0];
  if (subject) {
    const cmd = findCommand(subject);
    if (!cmd) {
      emit.event(
        { type: 'error', name: 'UsageError', message: `unknown command: ${subject}` },
        () => `unknown command: ${subject}`,
      );
      emit.finish();
      return 64;
    }
    emit.event(
      { type: 'help', command: cmd },
      () => renderTextHelp(subject),
    );
    emit.finish();
    return 0;
  }

  emit.event(
    {
      type: 'help',
      cli: { name: CLI_SPEC.name, version: CLI_SPEC.version, description: CLI_SPEC.description },
      commands: CLI_SPEC.commands.map((c) => ({ name: c.name, description: c.description, mutating: c.mutating })),
      globalOptions: CLI_SPEC.globalOptions,
    },
    () => renderTextHelp(),
  );
  emit.finish();
  return 0;
}

export function versionCommand(emit: Emitter): number {
  emit.event(
    { type: 'version', version: CLI_SPEC.version, name: CLI_SPEC.name },
    () => CLI_SPEC.version,
  );
  emit.finish();
  return 0;
}
