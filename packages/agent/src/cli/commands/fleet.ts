/**
 * `agent fleet` — launch N concurrent sessions for isolation testing.
 * Reuses the same event vocabulary as `agent run` but adds a final
 * `fleet_summary` event with per-session totals + the isolation flag.
 */

import { createAgentSession } from '../../session.js';
import { createReactLoopStrategy } from '../../strategy.js';
import { createDispatch, createToolRegistry } from '../../tools.js';
import { createMetricsCollector } from '../../metrics.js';
import type { SessionEvent, ToolContext } from '../../index.js';
import { fakeSandbox, scriptedLlm, writeRulesTool } from '../fixtures.js';
import type { Emitter } from '../output.js';
import { openSessionLog } from '../session-log.js';
import type { ParsedArgs } from '../parse.js';

export interface FleetCommandIO {
  emit: Emitter;
  now?: () => string;
  openLog?: typeof openSessionLog;
}

interface MemberPlan {
  id: string;
  presetId: string;
  prompt: string;
}

function plan(size: number): MemberPlan[] {
  const presets = ['chess', 'lobby', 'owner', 'corpus', 'forum'] as const;
  return Array.from({ length: size }, (_, i) => {
    const preset = presets[i % presets.length]!;
    return {
      id: `s${i + 1}`,
      presetId: preset,
      prompt: `Session ${i + 1}: write rules for ${preset}`,
    };
  });
}

export async function fleetCommand(args: ParsedArgs, io: FleetCommandIO): Promise<number> {
  const emit = io.emit;
  const now = io.now ?? (() => new Date().toISOString());
  const openLog = io.openLog ?? openSessionLog;

  const size = (args.options['size'] as number | undefined) ?? 3;
  if (size < 1 || size > 64) {
    throw new Error('--size must be 1..64');
  }
  const logDir = (args.options['log-dir'] as string | undefined) ?? null;
  const disableLog = Boolean(args.options['no-log']);
  const members = plan(size);

  if (args.options['dry-run']) {
    emit.event(
      {
        type: 'dry_run_plan',
        ts: now(),
        command: 'fleet',
        size,
        members: members.map((m) => ({ id: m.id, presetId: m.presetId })),
        logDir: logDir ?? '~/.pyric/sessions',
      },
      () => `[plan] fleet · size=${size} · members=${members.map((m) => m.id).join(',')}`,
    );
    emit.finish();
    return 0;
  }

  emit.event(
    { type: 'fleet_start', ts: now(), size, members: members.map((m) => m.id) },
    () => `[fleet] launching ${size} sessions`,
  );

  const startedAt = performance.now();

  const results = await Promise.all(
    members.map(async (member) => {
      const registry = createToolRegistry();
      registry.register(writeRulesTool);
      const metrics = createMetricsCollector();
      const sandbox = fakeSandbox();
      const log = openLog({ logDir, sessionId: member.id, disabled: disableLog });

      const session = createAgentSession({
        strategy: createReactLoopStrategy(),
        llm: scriptedLlm('write-rules', member.id),
        tools: createDispatch(registry),
        toolList: registry.list(),
        toolContext: (): ToolContext => ({
          workspace: session.workspace,
          runtime: session.runtime,
          sandbox,
          lint: () => ({ warnings: [] }),
          signal: new AbortController().signal,
        }),
        systemPromptBuilder: (w) => `Session ${member.id} preset=${w.presetId || member.presetId}`,
        metrics,
        history: [],
        id: member.id,
      });

      log.write({ type: 'session_start', ts: now(), sessionId: member.id, scenario: 'write-rules' });

      let eventCount = 0;
      for await (const ev of session.submit(member.prompt, AbortSignal.timeout(30_000)) as AsyncIterable<SessionEvent>) {
        eventCount += 1;
        if (ev.kind === 'turn_completed') {
          const turnEvent = {
            type: 'turn_end',
            ts: now(),
            sessionId: member.id,
            turn: ev.turnId,
            metrics: {
              tokensIn: ev.metrics.tokensIn,
              tokensOut: ev.metrics.tokensOut,
              costUsd: ev.metrics.costUsd,
            },
          };
          log.write(turnEvent);
          emit.event(
            turnEvent,
            () => `[${member.id}] turn done · ${ev.metrics.tokensIn}+${ev.metrics.tokensOut}t`,
          );
        } else if (ev.kind === 'tool_finished') {
          const toolEvent = {
            type: 'tool_result',
            ts: now(),
            sessionId: member.id,
            callId: ev.callId,
            ok: ev.result.ok,
            summary: ev.result.summary,
          };
          log.write(toolEvent);
          emit.event(
            toolEvent,
            () => `[${member.id}] tool ${ev.callId} ${ev.result.ok ? 'ok' : 'fail'}`,
          );
        } else if (ev.kind === 'error') {
          const errEvent = { type: 'session_error', ts: now(), sessionId: member.id, message: ev.message };
          log.write(errEvent);
          emit.event(errEvent, () => `[${member.id}] error: ${ev.message}`);
        }
      }

      const totals = metrics.totals();
      const summary = {
        id: member.id,
        presetId: member.presetId,
        rulesLength: session.workspace.rules.length,
        ownIdInRules: session.workspace.rules.includes(member.id),
        tokens: totals.tokensTotal,
        costUsd: totals.costUsdTotal,
        turns: totals.turnCount,
        events: eventCount,
        logPath: log.path,
      };
      log.write({ type: 'session_end', ts: now(), sessionId: member.id, totals: summary });
      log.close();
      return summary;
    }),
  );

  const elapsedMs = performance.now() - startedAt;
  const allIsolated = results.every((r) => r.ownIdInRules);

  emit.event(
    {
      type: 'fleet_summary',
      ts: now(),
      size,
      elapsedMs,
      isolated: allIsolated,
      aggregateTokens: results.reduce((sum, r) => sum + r.tokens, 0),
      aggregateCostUsd: results.reduce((sum, r) => sum + r.costUsd, 0),
      results,
    },
    () =>
      `[fleet] done · ${size} sessions · ${elapsedMs.toFixed(1)}ms · isolation=${allIsolated ? 'ok' : 'LEAK'} · tokens=${results.reduce((s, r) => s + r.tokens, 0)}`,
  );

  emit.finish();
  return allIsolated ? 0 : 1;
}
