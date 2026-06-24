import type { ModelClient, ModelEvent, ModelMessage, ModelRequest, ToolSpec } from '../contract.js';
import { readSseDataLines } from '../sse.js';
import { normalizeModelUsage } from '../usage.js';
import type { CloudProviderConfig } from './types.js';
/**
 * Requesty provider — talks to /v1/chat/completions with streaming SSE.
 * Requesty (https://requesty.ai) is an OpenAI-compatible LLM gateway that
 * routes a single API across many model providers, using the same
 * `provider/model` naming as OpenRouter. Environment-agnostic: runs
 * unchanged page-side and inside the relay. The only globals it touches
 * are `fetch`, `TextDecoder` (via ../sse), and `JSON`.
 *
 * Mirrors the OpenRouter provider: same OAI message conversion, same
 * tool-call accumulation by index, same `usage.include` request for
 * real-dollar cost, same unified `reasoning` parameter and
 * reasoning-token pass-through.
 */

const ENDPOINT = 'https://router.requesty.ai/v1/chat/completions';

/** Construction config for the Requesty provider. */
export interface RequestyConfig extends CloudProviderConfig {}

interface OaiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
  name?: string;
}

function toOaiMessages(messages: ModelMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      out.push({ role: m.role, content: m.text ?? '' });
      continue;
    }
    if (m.role === 'assistant') {
      const msg: OaiMessage = { role: 'assistant', content: m.text ?? '' };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: {
            name: c.name,
            arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}),
          },
        }));
        // OpenAI dislikes assistant messages with both empty content
        // and tool_calls present — null content is the documented form.
        if (!msg.content) msg.content = null;
      }
      out.push(msg);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId ?? '',
        name: m.name ?? '',
        content: m.resultJson ?? '',
      });
    }
  }
  return out;
}

export function toOaiTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
  emitted: boolean;
}

/**
 * Build a Requesty `ModelClient`. Construction values (apiKey, model)
 * come in the config; per-call values (messages, tools, sampling,
 * reasoning) come in the `ModelRequest`.
 */
export function requestyModelClient(config: RequestyConfig): ModelClient {
  return {
    id: `requesty:${config.model}`,
    supportsTools: true,
    async *chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      const effort = req.reasoningEffort ?? 'off';
      // Per-request temperature wins; otherwise fall back to the
      // construction-time default. Relay sets neither.
      const temperature = req.temperature ?? config.temperature;
      const body = {
        model: config.model,
        messages: toOaiMessages(req.messages),
        stream: true,
        // Ask Requesty to include cost + cached-token telemetry in the
        // final usage chunk.
        usage: { include: true },
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof req.topP === 'number' ? { top_p: req.topP } : {}),
        ...(typeof req.topK === 'number' ? { top_k: req.topK } : {}),
        // Requesty's unified reasoning parameter (same shape as OpenRouter):
        //   - `effort: 'off'` → send `reasoning: { enabled: false }`.
        //     Just OMITTING the field doesn't actually disable reasoning
        //     on Anthropic / DeepSeek / GLM / Kimi / MiniMax thinking
        //     models — the gateway falls back to each model's default
        //     thinking budget, the models burn minutes producing
        //     reasoning, and slow connections time out streaming it back.
        //     `{ enabled: false }` is the documented explicit-disable.
        //   - effort low/medium/high → set effort + ask for the summary
        //     and reasoning deltas (`summary: 'auto'` is required for
        //     GPT-5 to surface reasoning deltas; `include_reasoning: true`
        //     is the legacy alias still honored by older proxy versions).
        ...(effort === 'off'
          ? { reasoning: { enabled: false } }
          : {
              reasoning: { effort, summary: 'auto' },
              include_reasoning: true,
            }),
        ...(req.tools.length > 0
          ? { tools: toOaiTools(req.tools), tool_choice: 'auto' as const }
          : {}),
      };

      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://pyric-playground.web.app',
            'X-Title': 'Pyric Playground',
          },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        if (signal?.aborted) return;
        yield { kind: 'error', message: e instanceof Error ? e.message : String(e) };
        return;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        yield { kind: 'error', message: `Requesty ${response.status}: ${text.slice(0, 240)}` };
        return;
      }

      let promptTokens = 0;
      let completionTokens = 0;
      let cachedTokens: number | undefined;
      let reasoningTokens: number | undefined;
      let costUsd: number | undefined;
      const pending = new Map<number, PendingToolCall>();

      try {
        for await (const payload of readSseDataLines(response.body)) {
          if (payload === '[DONE]') break;
          if (signal?.aborted) return;
          let evt: unknown;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          const e = evt as {
            choices?: {
              delta?: {
                content?: string;
                reasoning?: string;
                reasoning_content?: string;
                tool_calls?: {
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }[];
              };
            }[];
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              prompt_tokens_details?: {
                cached_tokens?: number;
              };
              completion_tokens_details?: {
                reasoning_tokens?: number;
              };
              reasoning_tokens?: number;
              cost?: number;
            };
          };
          const delta = e.choices?.[0]?.delta;
          if (delta?.content) {
            yield { kind: 'text', text: delta.content };
          }
          const reasoning = delta?.reasoning ?? delta?.reasoning_content;
          if (reasoning) {
            yield { kind: 'thinking', text: reasoning };
          }
          if (delta?.tool_calls) {
            for (const d of delta.tool_calls) {
              let p = pending.get(d.index);
              if (!p) {
                p = { id: d.id ?? '', name: '', args: '', emitted: false };
                pending.set(d.index, p);
              }
              if (d.id) p.id = d.id;
              if (d.function?.name) p.name = d.function.name;
              if (d.function?.arguments) p.args += d.function.arguments;
            }
          }
          if (e.usage) {
            promptTokens = e.usage.prompt_tokens ?? promptTokens;
            completionTokens = e.usage.completion_tokens ?? completionTokens;
            if (typeof e.usage.prompt_tokens_details?.cached_tokens === 'number') {
              cachedTokens = e.usage.prompt_tokens_details.cached_tokens;
            }
            if (typeof e.usage.completion_tokens_details?.reasoning_tokens === 'number') {
              reasoningTokens = e.usage.completion_tokens_details.reasoning_tokens;
            } else if (typeof e.usage.reasoning_tokens === 'number') {
              reasoningTokens = e.usage.reasoning_tokens;
            }
            if (typeof e.usage.cost === 'number') costUsd = e.usage.cost;
          }
        }
      } catch (e) {
        if (signal?.aborted) return;
        yield { kind: 'error', message: e instanceof Error ? e.message : String(e) };
        return;
      }

      // Tool calls are streamed argument-by-argument; we wait until the
      // stream closes before parsing + emitting so we don't fire on
      // half-parsed JSON.
      for (const p of pending.values()) {
        if (p.emitted) continue;
        let parsedArgs: unknown = {};
        try {
          parsedArgs = p.args ? JSON.parse(p.args) : {};
        } catch {
          parsedArgs = { _raw: p.args };
        }
        yield {
          kind: 'tool_call',
          id: p.id || `rq_${Math.random().toString(36).slice(2, 10)}`,
          name: p.name,
          args: parsedArgs,
        };
        p.emitted = true;
      }

      yield {
        kind: 'usage',
        usage: normalizeModelUsage({
          promptTokens,
          outputTokens: completionTokens,
          ...(typeof cachedTokens === 'number' ? { cachedTokens } : {}),
          ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
          ...(typeof costUsd === 'number' ? { costUsd } : {}),
        }),
      };
    },
  };
}
