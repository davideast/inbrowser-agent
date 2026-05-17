/**
 * `createReactLoopStrategy()` — the default `AgentStrategy`.
 *
 * Implements the playground's current ReAct-style behavior:
 *
 *   1. Compose `[system, ...history, user(prompt)]` as the message
 *      array.
 *   2. Issue one chat call against the LLM with the tool list.
 *   3. Stream `text` / `thinking` / `tool_call` events through.
 *   4. When the LLM produces tool calls, dispatch each one, append
 *      the result message, and loop back to step 2.
 *   5. When the LLM produces no tool calls in a turn, emit
 *      `turn_complete` and finish.
 *
 * Future strategies (planner-executor, graph-of-thoughts,
 * parallel-branch ensembling) sit alongside this one — same
 * `AgentStrategy` interface, different control flow.
 */

import { isParallelSafe } from './tools.js';
import type { NormalizedMessage, TurnDetails } from './types/chat.js';
import type { ChatEvent, ChatRequest, RawUsage } from './types/llm.js';
import type { AgentStrategy, StrategyEvent, StrategyRunInput } from './types/strategy.js';
import type { ToolHandler, ToolResult } from './types/tools.js';

interface ReactLoopOptions {
  /** Cap on loop iterations to avoid runaway tool-call ping-pong. Default 24. */
  maxTurns?: number;
  /**
   * Opt-in: when `true`, tool calls produced in a single turn are partitioned
   * by the handler's `parallelSafe` tag. Parallel-safe calls run concurrently
   * with `Promise.all`; the remaining (mutation) calls run sequentially after
   * the parallel group settles. Result yield order and `messages` order are
   * preserved in the original input order, so the trace and next-turn prompt
   * are byte-for-byte identical to a sequential run — the only observable
   * difference is wall-clock.
   *
   * Defaults to `false` (current behavior: every call serialised).
   */
  parallelDispatch?: boolean;
}

export function createReactLoopStrategy(options: ReactLoopOptions = {}): AgentStrategy {
  const maxTurns = options.maxTurns ?? 24;
  const parallelDispatch = options.parallelDispatch === true;
  return {
    id: 'react-loop',
    async *run(input: StrategyRunInput, signal: AbortSignal): AsyncIterable<StrategyEvent> {
      const messages: NormalizedMessage[] = buildMessages(input);

      for (let turn = 0; turn < maxTurns; turn++) {
        if (signal.aborted) {
          yield { kind: 'error', message: 'aborted' };
          return;
        }

        const toolDecls = input.toolList.map((h) => ({
          name: h.name,
          description: h.description,
          parameters: h.parameters,
        }));
        const chatRequest: ChatRequest = {
          messages,
          tools: toolDecls,
          toolUseEnabled: toolDecls.length > 0 && input.llm.supportsTools,
        };

        // Emit the trace BEFORE dispatch. Captures the request as the
        // strategy assembled it — agent-layer view, not provider-
        // specific. The `requestId` is `${turnId}#${iteration}`
        // when the session passed a `turnId`; otherwise we synthesize
        // a per-iteration id so the trace stays consistent for
        // standalone strategy callers (CLI, eval harness).
        const turnIdForReq = input.turnId ?? 'turn-anon';
        const requestId = `${turnIdForReq}#${turn}`;
        if (input.tracer) {
          input.tracer.emit({
            kind: 'llm_request',
            data: {
              requestId,
              turnId: turnIdForReq,
              iteration: turn,
              ts: Date.now(),
              systemPrompt: input.systemPrompt,
              // Shallow-clone arrays to detach the captured view from
              // the in-loop `messages` array that grows under our
              // feet on each ReAct iteration. Each iteration's trace
              // must reflect the messages AS-SENT at that iteration.
              messages: messages.map((m) => ({ ...m })),
              tools: toolDecls.map((t) => ({ ...t })),
              llm: { id: input.llm.id, supportsTools: input.llm.supportsTools },
            },
          });
        }

        const pendingToolCalls: { id: string; name: string; args: unknown; signature?: string }[] =
          [];
        let turnUsage: RawUsage | undefined;
        let turnDetails: TurnDetails | undefined;
        let assistantText = '';
        let assistantThinking = '';

        // Stream the model's reply.
        for await (const ev of input.llm.chat(chatRequest, signal) as AsyncIterable<ChatEvent>) {
          if (ev.kind === 'text') {
            assistantText += ev.chunk;
            yield { kind: 'text', chunk: ev.chunk };
          } else if (ev.kind === 'thinking') {
            assistantThinking += ev.chunk;
            yield { kind: 'thinking', chunk: ev.chunk };
          } else if (ev.kind === 'tool_call') {
            pendingToolCalls.push({
              id: ev.id,
              name: ev.name,
              args: ev.args,
              ...(ev.signature ? { signature: ev.signature } : {}),
            });
            yield {
              kind: 'tool_call',
              id: ev.id,
              name: ev.name,
              args: ev.args,
              ...(ev.signature ? { signature: ev.signature } : {}),
            };
          } else if (ev.kind === 'turn_complete') {
            turnUsage = ev.usage;
            turnDetails = ev.details;
          } else if (ev.kind === 'error') {
            yield { kind: 'error', message: ev.message };
            return;
          }
        }

        // Pair with the `llm_request` emitted above. Captures the
        // moment the chat() iterator drained — the closing endpoint
        // of this iteration's language-model wall-clock segment.
        if (input.tracer) {
          input.tracer.emit({
            kind: 'llm_response',
            data: {
              requestId,
              ts: Date.now(),
              text: assistantText,
              thinking: assistantThinking,
              toolCalls: pendingToolCalls.map((tc) => ({
                id: tc.id,
                name: tc.name,
                args: tc.args,
                ...(tc.signature ? { signature: tc.signature } : {}),
              })),
              ...(turnUsage
                ? {
                    usage: {
                      promptTokens: turnUsage.promptTokens,
                      outputTokens: turnUsage.completionTokens,
                      ...(turnUsage.cachedTokens !== undefined
                        ? { cachedTokens: turnUsage.cachedTokens }
                        : {}),
                    },
                  }
                : {}),
            },
          });
        }

        // No tool calls → final assistant turn, emit turn_complete + done.
        if (pendingToolCalls.length === 0) {
          if (turnUsage && turnDetails) {
            yield { kind: 'turn_complete', usage: turnUsage, details: turnDetails };
          }
          return;
        }

        // Tool calls → run each, append result message, loop.
        messages.push({
          role: 'assistant',
          text: assistantText,
          toolCalls: pendingToolCalls.map((tc) => ({
            callId: tc.id,
            name: tc.name,
            args: tc.args,
            ...(tc.signature ? { signature: tc.signature } : {}),
          })),
        });

        if (parallelDispatch) {
          // Resolve each call's handler so we can ask `isParallelSafe`.
          // Missing handler (defensive — shouldn't happen) → treated as
          // not parallel-safe, so it falls into the sequential group.
          const handlersByName = new Map<string, ToolHandler>();
          for (const h of input.toolList) handlersByName.set(h.name, h);
          const parallelIndices: number[] = [];
          const sequentialIndices: number[] = [];
          for (let i = 0; i < pendingToolCalls.length; i++) {
            const c = pendingToolCalls[i]!;
            const h = handlersByName.get(c.name);
            if (h && isParallelSafe(h)) parallelIndices.push(i);
            else sequentialIndices.push(i);
          }

          // Pre-allocate result slots so even when the parallel group
          // settles out of order, we yield + push messages in the
          // original input order. The trace and next-turn prompt must
          // be identical to the sequential mode — only wall-clock
          // differs.
          const results: ToolResult[] = new Array(pendingToolCalls.length);

          // Parallel-safe group: run concurrently. Handler errors are
          // already normalised into `{ ok: false }` results by the
          // dispatch layer, so Promise.all never rejects in practice.
          if (parallelIndices.length > 0) {
            await Promise.all(
              parallelIndices.map(async (i) => {
                const call = pendingToolCalls[i]!;
                results[i] = await input.tools.execute(
                  { id: call.id, name: call.name, args: call.args },
                  input.toolContext(),
                );
              }),
            );
          }
          // Mutation group: still sequential, in original relative order.
          for (const i of sequentialIndices) {
            if (signal.aborted) {
              yield { kind: 'error', message: 'aborted' };
              return;
            }
            const call = pendingToolCalls[i]!;
            results[i] = await input.tools.execute(
              { id: call.id, name: call.name, args: call.args },
              input.toolContext(),
            );
          }

          // Yield + append in original input order.
          for (let i = 0; i < pendingToolCalls.length; i++) {
            const call = pendingToolCalls[i]!;
            const result = results[i]!;
            yield { kind: 'tool_result', id: call.id, result };
            messages.push({
              role: 'tool',
              callId: call.id,
              name: call.name,
              resultJson: JSON.stringify(safeSerializable(result)),
              text: '',
            });
          }
        } else {
          // Default behavior: byte-for-byte identical to the pre-change
          // sequential loop — dispatch, yield, push, in order, one at a
          // time.
          for (const call of pendingToolCalls) {
            const result: ToolResult = await input.tools.execute(
              { id: call.id, name: call.name, args: call.args },
              input.toolContext(),
            );
            yield { kind: 'tool_result', id: call.id, result };
            messages.push({
              role: 'tool',
              callId: call.id,
              name: call.name,
              resultJson: JSON.stringify(safeSerializable(result)),
              text: '',
            });
          }
        }
        // Close the tool-dispatch segment for this iteration. Pair
        // with the `llm_response` emitted above; `ts` delta is the
        // dispatch wall-clock the eval harness consumes.
        if (input.tracer) {
          input.tracer.emit({
            kind: 'turn_dispatch_complete',
            data: {
              requestId,
              turnId: turnIdForReq,
              iteration: turn,
              ts: Date.now(),
              toolCallCount: pendingToolCalls.length,
            },
          });
        }
        // Loop to next turn.
        if (turnUsage && turnDetails) {
          yield { kind: 'turn_complete', usage: turnUsage, details: turnDetails };
        }
      }

      yield {
        kind: 'error',
        message: `react-loop: exceeded maxTurns (${maxTurns}) without settling`,
      };
    },
  };
}

function buildMessages(input: StrategyRunInput): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  out.push({ role: 'system', text: input.systemPrompt });
  for (const m of input.history) {
    if (m.role === 'system') continue; // already emitted
    if (m.role === 'assistant') {
      const tc =
        m.toolCalls?.map((c) => ({
          callId: c.id,
          name: c.name,
          args: safeParse(c.argsJson),
          ...(c.signature ? { signature: c.signature } : {}),
        })) ?? [];
      out.push({
        role: 'assistant',
        text: m.text,
        ...(tc.length > 0 ? { toolCalls: tc } : {}),
      });
      for (const c of m.toolCalls ?? []) {
        if (c.resultJson !== undefined) {
          out.push({
            role: 'tool',
            callId: c.id,
            name: c.name,
            resultJson: c.resultJson,
            text: '',
          });
        }
      }
    } else {
      out.push({ role: m.role, text: m.text });
    }
  }
  out.push({ role: 'user', text: input.prompt });
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function safeSerializable(value: ToolResult): unknown {
  // Strip non-serializable fields (functions, symbols) that might
  // sneak into ToolResult.data. Most handlers return plain objects;
  // this is belt-and-suspenders.
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { ok: value.ok, summary: value.summary };
  }
}
