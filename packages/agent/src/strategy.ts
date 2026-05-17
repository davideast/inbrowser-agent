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
import type {
  AgentStrategy,
  ReflexionConfig,
  StrategyEvent,
  StrategyRunInput,
} from './types/strategy.js';
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
  /**
   * Opt-in critique-and-retry pass after a candidate final-answer turn.
   * See `ReflexionConfig` for the verdict shape and the retry/exhaust
   * semantics. When absent or `enabled: false`, behavior is byte-for-byte
   * identical to the pre-reflexion loop.
   */
  reflexion?: ReflexionConfig;
}

const DEFAULT_CRITIQUE_SYSTEM_PROMPT =
  'You are reviewing the assistant\'s most recent reply for consistency with the tool results visible earlier in this conversation. Reply with a single JSON object of the form {"ok": boolean, "feedback"?: string}. Set ok=true when the reply is supported by the tool results and follows the user\'s request. Set ok=false and supply a one-sentence feedback string when the reply contains a claim not grounded in the prior tool results, contradicts a prior tool result, or fails to answer the user\'s request. Do not include any other prose.';

export function createReactLoopStrategy(options: ReactLoopOptions = {}): AgentStrategy {
  const maxTurns = options.maxTurns ?? 24;
  const parallelDispatch = options.parallelDispatch === true;
  const reflexionEnabled = options.reflexion?.enabled === true;
  const reflexionMaxRetries = Math.max(0, options.reflexion?.maxRetries ?? 1);
  const critiqueSystemPrompt =
    options.reflexion?.critiqueSystemPrompt ?? DEFAULT_CRITIQUE_SYSTEM_PROMPT;
  return {
    id: 'react-loop',
    async *run(input: StrategyRunInput, signal: AbortSignal): AsyncIterable<StrategyEvent> {
      const messages: NormalizedMessage[] = buildMessages(input);
      // Per-call retry budget for the critique-and-retry pass. Only
      // consulted when `reflexionEnabled` is true; otherwise the
      // critique branch is skipped entirely and the strategy returns
      // on the first no-tool-calls turn exactly as before.
      let reflexionRetriesRemaining = reflexionMaxRetries;

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

        // No tool calls → final assistant turn. Without reflexion we
        // emit turn_complete and return immediately. With reflexion
        // enabled we issue a critique call against the model, parse a
        // verdict, and either return (ok / exhausted) or inject the
        // critique feedback as a synthetic user message and loop into
        // a fresh ReAct iteration.
        if (pendingToolCalls.length === 0) {
          if (!reflexionEnabled) {
            if (turnUsage && turnDetails) {
              yield { kind: 'turn_complete', usage: turnUsage, details: turnDetails };
            }
            return;
          }

          // Append the candidate final-answer assistant turn to the
          // conversation so the critique call (and any retry) sees it.
          // We only do this when reflexion is enabled — the
          // pre-reflexion path returns without ever appending the
          // final assistant turn, and we must not change that byte for
          // byte when reflexion is disabled.
          messages.push({ role: 'assistant', text: assistantText });

          const critiqueMessages: NormalizedMessage[] = [
            { role: 'system', text: critiqueSystemPrompt },
            // Skip the original system prompt — the critique system
            // prompt replaces it. Everything else (history + user
            // prompt + assistant turns + tool results) is included so
            // the critic can evaluate the reply in context.
            ...messages.filter((m) => m.role !== 'system'),
            {
              role: 'user',
              text: "Evaluate the assistant's most recent reply. Reply with the JSON verdict only.",
            },
          ];
          const critiqueRequest: ChatRequest = {
            messages: critiqueMessages,
            tools: [],
            toolUseEnabled: false,
          };

          const critiqueRequestId = `${requestId}#critique`;
          if (input.tracer) {
            input.tracer.emit({
              kind: 'llm_request',
              data: {
                requestId: critiqueRequestId,
                turnId: turnIdForReq,
                iteration: turn,
                ts: Date.now(),
                systemPrompt: critiqueSystemPrompt,
                messages: critiqueMessages.map((m) => ({ ...m })),
                tools: [],
                llm: { id: input.llm.id, supportsTools: input.llm.supportsTools },
              },
            });
          }

          let critiqueText = '';
          let critiqueUsage: RawUsage | undefined;
          for await (const ev of input.llm.chat(
            critiqueRequest,
            signal,
          ) as AsyncIterable<ChatEvent>) {
            if (ev.kind === 'text') {
              critiqueText += ev.chunk;
            } else if (ev.kind === 'turn_complete') {
              critiqueUsage = ev.usage;
            } else if (ev.kind === 'error') {
              // Critique errored — fail open, return the candidate
              // final-answer turn as-is. Never block completion on a
              // critique failure.
              if (input.tracer) {
                input.tracer.emit({
                  kind: 'llm_response',
                  data: {
                    requestId: critiqueRequestId,
                    ts: Date.now(),
                    text: critiqueText,
                    thinking: '',
                    toolCalls: [],
                  },
                });
              }
              if (turnUsage && turnDetails) {
                yield { kind: 'turn_complete', usage: turnUsage, details: turnDetails };
              }
              return;
            }
            // Tool calls / thinking events on the critique call are
            // ignored — the critique request sets toolUseEnabled:false
            // and asks for a JSON reply, so a well-behaved stub never
            // emits them. Real providers may still stream thinking;
            // we do not surface it to the caller.
          }

          if (input.tracer) {
            input.tracer.emit({
              kind: 'llm_response',
              data: {
                requestId: critiqueRequestId,
                ts: Date.now(),
                text: critiqueText,
                thinking: '',
                toolCalls: [],
                ...(critiqueUsage
                  ? {
                      usage: {
                        promptTokens: critiqueUsage.promptTokens,
                        outputTokens: critiqueUsage.completionTokens,
                        ...(critiqueUsage.cachedTokens !== undefined
                          ? { cachedTokens: critiqueUsage.cachedTokens }
                          : {}),
                      },
                    }
                  : {}),
              },
            });
          }

          const verdict = parseCritiqueVerdict(critiqueText);

          if (verdict.ok) {
            yield {
              kind: 'custom',
              name: 'reflexion_critique',
              data: { verdict: 'ok', text: critiqueText },
            };
            if (turnUsage && turnDetails) {
              yield { kind: 'turn_complete', usage: turnUsage, details: turnDetails };
            }
            return;
          }

          if (reflexionRetriesRemaining <= 0) {
            yield {
              kind: 'custom',
              name: 'reflexion_critique',
              data: {
                verdict: 'exhausted',
                text: critiqueText,
                ...(verdict.feedback ? { feedback: verdict.feedback } : {}),
              },
            };
            if (turnUsage && turnDetails) {
              yield { kind: 'turn_complete', usage: turnUsage, details: turnDetails };
            }
            return;
          }

          yield {
            kind: 'custom',
            name: 'reflexion_critique',
            data: {
              verdict: 'retry',
              text: critiqueText,
              ...(verdict.feedback ? { feedback: verdict.feedback } : {}),
            },
          };
          if (turnUsage && turnDetails) {
            yield { kind: 'turn_complete', usage: turnUsage, details: turnDetails };
          }

          const feedback = verdict.feedback ?? 'Your previous response needs revision.';
          messages.push({
            role: 'user',
            text: `Reviewer feedback: ${feedback}. Please revise your response.`,
          });
          reflexionRetriesRemaining -= 1;
          continue;
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

/**
 * Extract the reflexion verdict from a critique LLM reply. Returns
 * `{ ok: true }` on any parse failure (fail-open: the strategy must
 * not block completion on a malformed critique). Handles three shapes
 * the model commonly emits:
 *
 *   - a bare JSON object: `{"ok": false, "feedback": "..."}`
 *   - a JSON object inside a ```json fenced code block
 *   - a JSON object embedded in prose; we regex-extract the first
 *     `{...}` substring and try to parse it
 *
 * Anything else — no braces, broken JSON, JSON missing the `ok`
 * field — falls open.
 */
function parseCritiqueVerdict(text: string): { ok: boolean; feedback?: string } {
  if (!text || typeof text !== 'string') return { ok: true };
  // Strip ```json ... ``` fences (and bare ``` fences) before regex
  // hunting for the JSON object. Models often wrap the verdict in a
  // fence even when asked not to.
  let candidate = text.trim();
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    candidate = fenceMatch[1].trim();
  }
  // Greedy match: take everything from the first `{` to the last `}`
  // so nested braces survive. JSON.parse will reject malformed input.
  const objectMatch = candidate.match(/\{[\s\S]*\}/);
  if (!objectMatch) return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(objectMatch[0]);
  } catch {
    return { ok: true };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: true };
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.ok !== 'boolean') return { ok: true };
  const out: { ok: boolean; feedback?: string } = { ok: obj.ok };
  if (typeof obj.feedback === 'string' && obj.feedback.length > 0) {
    out.feedback = obj.feedback;
  }
  return out;
}
