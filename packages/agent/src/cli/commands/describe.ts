/**
 * `agent describe` — emit machine-readable descriptions of CLI subjects.
 * Targets:
 *   - commands: the subcommand tree from `spec.ts`
 *   - scenarios: scripted LLM fixtures + their turn shapes
 *   - events: the NDJSON event-type catalog the CLI emits
 *   - all: a single combined object (default)
 *
 * Always emits exactly one event so it's safe to pipe through `jq`.
 */

import type { Emitter } from '../output.js';
import type { ParsedArgs } from '../parse.js';
import { CLI_SPEC } from '../spec.js';

const SCENARIOS = [
  {
    id: 'echo',
    description: 'Echoes the user prompt back as text. Single turn, no tool calls.',
    turns: 1,
  },
  {
    id: 'write-rules',
    description:
      'Two-turn flow: turn 0 emits a tool_call (writeRules), turn 1 emits a summary text response.',
    turns: 2,
  },
];

const EVENTS = [
  {
    type: 'session_start',
    whenEmitted: 'first event of every run',
    fields: ['ts', 'sessionId', 'scenario', 'maxTurns'],
  },
  {
    type: 'turn_start',
    whenEmitted: 'beginning of each agent turn',
    fields: ['ts', 'sessionId', 'turn'],
  },
  {
    type: 'thinking',
    whenEmitted: 'streaming reasoning chunk (if provided)',
    fields: ['ts', 'sessionId', 'chunk'],
  },
  {
    type: 'text',
    whenEmitted: 'streaming assistant text chunk',
    fields: ['ts', 'sessionId', 'chunk'],
  },
  {
    type: 'tool_call',
    whenEmitted: 'agent invokes a tool',
    fields: ['ts', 'sessionId', 'name', 'callId', 'args'],
  },
  {
    type: 'tool_result',
    whenEmitted: 'tool dispatch finishes',
    fields: ['ts', 'sessionId', 'callId', 'ok', 'summary'],
  },
  {
    type: 'workspace_changed',
    whenEmitted: 'tool result patches the workspace',
    fields: ['ts', 'sessionId', 'rulesLength', 'codeLength'],
  },
  {
    type: 'turn_end',
    whenEmitted: 'turn metrics finalized',
    fields: ['ts', 'sessionId', 'turn', 'metrics'],
  },
  {
    type: 'sandbox_event',
    whenEmitted: 'sandbox observer event',
    fields: ['ts', 'sessionId', 'kind', 'detail'],
  },
  {
    type: 'strategy_event',
    whenEmitted: 'strategy-level milestone',
    fields: ['ts', 'sessionId', 'name', 'data'],
  },
  {
    type: 'session_error',
    whenEmitted: 'session-level error from the strategy',
    fields: ['ts', 'sessionId', 'message'],
  },
  {
    type: 'session_end',
    whenEmitted: 'last event of every run, carries totals',
    fields: ['ts', 'sessionId', 'totals', 'logPath', 'exit'],
  },
  {
    type: 'fleet_start',
    whenEmitted: 'agent fleet, before launching members',
    fields: ['ts', 'size', 'members'],
  },
  {
    type: 'fleet_summary',
    whenEmitted: 'agent fleet, after all members complete',
    fields: ['ts', 'size', 'elapsedMs', 'isolated', 'aggregateTokens', 'results'],
  },
  {
    type: 'dry_run_plan',
    whenEmitted: 'when --dry-run is set; replaces all runtime events',
    fields: ['ts', 'command', 'sessionId?', 'scenario?', 'logPath?'],
  },
  {
    type: 'undo_plan',
    whenEmitted: '`agent undo --dry-run`: plan only, no rollback recorded',
    fields: ['ts', 'eventId', 'originalTool', 'target', 'reverseOp'],
  },
  {
    type: 'undo_recorded',
    whenEmitted: '`agent undo`: rollback event appended to the log',
    fields: ['ts', 'rollbackEventId', 'eventId', 'reverseOp', 'nextStep'],
  },
  {
    type: 'migrate_plan',
    whenEmitted: '`agent migrate`: one per replayable commit (the forward direction)',
    fields: ['ts', 'eventId', 'tool', 'target', 'args'],
  },
  {
    type: 'migrate_summary',
    whenEmitted: '`agent migrate` (no --record): final summary line',
    fields: ['ts', 'plannedCount', 'skippedLegacy'],
  },
  {
    type: 'migrate_intent_recorded',
    whenEmitted: '`agent migrate --record`: intent marker appended to log',
    fields: ['ts', 'intentEventId', 'plannedCount', 'nextStep'],
  },
  {
    type: 'mutation_event',
    whenEmitted: '`agent events`: every line is one MutationEvent from the project log',
    fields: [
      'id',
      'ts',
      'agent',
      'sessionId',
      'tool',
      'args?',
      'phase',
      'target',
      'before?',
      'after?',
      'reversible',
      'reverseOp?',
      'metadata?',
    ],
  },
  {
    type: 'error',
    whenEmitted: 'CLI-level error (parsing, hardening, file resolution)',
    fields: ['ts', 'name', 'message', 'field?', 'reason?'],
  },
];

export function describeCommand(args: ParsedArgs, emit: Emitter): number {
  const target = (args.options['target'] as string | undefined) ?? 'all';

  const payload: Record<string, unknown> = (() => {
    if (target === 'commands') return { commands: CLI_SPEC.commands };
    if (target === 'scenarios') return { scenarios: SCENARIOS };
    if (target === 'events') return { events: EVENTS };
    return {
      cli: { name: CLI_SPEC.name, version: CLI_SPEC.version, description: CLI_SPEC.description },
      commands: CLI_SPEC.commands,
      globalOptions: CLI_SPEC.globalOptions,
      scenarios: SCENARIOS,
      events: EVENTS,
    };
  })();

  emit.event({ type: 'describe', target, ...payload }, () => {
    if (target === 'commands' || target === 'all') {
      return CLI_SPEC.commands.map((c) => `${c.name.padEnd(10)} ${c.description}`).join('\n');
    }
    if (target === 'scenarios') {
      return SCENARIOS.map((s) => `${s.id.padEnd(14)} ${s.description}`).join('\n');
    }
    return EVENTS.map((e) => `${e.type.padEnd(20)} ${e.whenEmitted}`).join('\n');
  });
  emit.finish();
  return 0;
}
