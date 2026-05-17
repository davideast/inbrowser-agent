/**
 * `agent` CLI entry. The `bin/agent.ts` shebang script is a one-liner
 * that imports `main` from here so the dispatching logic stays
 * importable + unit-testable.
 *
 * Top-level guarantees:
 *   - argv is parsed against `spec.ts` with input hardening enforced
 *     before any side effect.
 *   - Errors are emitted as a single structured event and surface as
 *     non-zero exit codes (64 for usage/hardening, 1 for runtime).
 *   - Output mode auto-selects: NDJSON when stdout is not a TTY,
 *     text when it is, overridden by --output.
 */

import { runCommand } from './commands/run.js';
import { fleetCommand } from './commands/fleet.js';
import { describeCommand } from './commands/describe.js';
import { schemaCommand } from './commands/schema.js';
import { helpCommand, versionCommand } from './commands/help.js';
import { eventsCommand } from './commands/events.js';
import { undoCommand } from './commands/undo.js';
import { serveCommand } from './commands/serve.js';
import { migrateCommand } from './commands/migrate.js';
import { createEmitter, errorEvent, pickMode } from './output.js';
import type { OutputMode } from './output.js';
import { InputHardeningError, parseArgs, UsageError } from './parse.js';
import type { AgentDefinition } from '../types/agent.js';
import type { ProjectContext } from '../types/project-context.js';

export interface MainOptions {
  argv?: readonly string[];
  cwd?: string;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  now?: () => string;
  /**
   * Agents to expose under `agent serve`. The bare CLI ships zero
   * built-ins; host packages wire their own here. Ignored by every
   * other subcommand.
   */
  serveAgents?: AgentDefinition[];
  /** Pre-built `ProjectContext` for `agent serve` live-mode tools. */
  serveAgentApp?: ProjectContext;
}

export async function main(opts: MainOptions = {}): Promise<number> {
  const argv = opts.argv ?? process.argv.slice(2);
  const cwd = opts.cwd ?? process.cwd();
  const stdout = opts.stdout ?? process.stdout;

  let mode: OutputMode = pickMode(undefined, stdout);
  let emit = createEmitter({ mode }, stdout);

  let args;
  try {
    args = parseArgs(argv, cwd);
  } catch (err) {
    if (err instanceof InputHardeningError) {
      emit.event(errorEvent(err), () => `error: ${err.message}`);
      emit.finish();
      return 64;
    }
    if (err instanceof UsageError) {
      emit.event(
        { type: 'error', name: 'UsageError', message: err.message, hint: err.hint },
        () => `error: ${err.message}${err.hint ? `\n  hint: ${err.hint}` : ''}`,
      );
      emit.finish();
      return 64;
    }
    emit.event(errorEvent(err));
    emit.finish();
    return 2;
  }

  // Honor --output / --fields globally (re-create the emitter now that we know).
  const requested = (args.options['output'] as OutputMode | undefined) ?? undefined;
  mode = pickMode(requested, stdout);
  const rawFields = args.options['fields'];
  const fields = Array.isArray(rawFields) ? rawFields : undefined;
  emit = createEmitter({ mode, fields }, stdout);

  // --help on any subcommand: re-route to the help command scoped to it.
  if (args.options['help']) {
    return helpCommand(
      { command: 'help', options: {}, positional: [args.command], remainder: [] },
      emit,
    );
  }

  try {
    switch (args.command) {
      case 'run':
        return await runCommand(args, { emit, now: opts.now });
      case 'fleet':
        return await fleetCommand(args, { emit, now: opts.now });
      case 'describe':
        return describeCommand(args, emit);
      case 'schema':
        return schemaCommand(emit);
      case 'events':
        return eventsCommand(args, { emit });
      case 'undo':
        return undoCommand(args, { emit, now: opts.now });
      case 'serve':
        return await serveCommand(args, {
          emit,
          now: opts.now,
          ...(opts.serveAgents ? { agents: opts.serveAgents } : {}),
          ...(opts.serveAgentApp ? { agentApp: opts.serveAgentApp } : {}),
        });
      case 'migrate':
        return migrateCommand(args, { emit, now: opts.now });
      case 'version':
        return versionCommand(emit);
      case 'help':
      default:
        return helpCommand(args, emit);
    }
  } catch (err) {
    if (err instanceof InputHardeningError) {
      emit.event(errorEvent(err), () => `error: ${err.message}`);
      emit.finish();
      return 64;
    }
    if (err instanceof UsageError) {
      emit.event(
        { type: 'error', name: 'UsageError', message: err.message, hint: err.hint },
        () => `error: ${err.message}${err.hint ? `\n  hint: ${err.hint}` : ''}`,
      );
      emit.finish();
      return 64;
    }
    emit.event(errorEvent(err), () => `error: ${err instanceof Error ? err.message : String(err)}`);
    emit.finish();
    return 1;
  }
}
