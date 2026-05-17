/**
 * OpenRouter provider — talks to /api/v1/chat/completions with
 * streaming SSE. Environment-agnostic: runs unchanged page-side and
 * inside the relay. The only globals it touches are `fetch`,
 * `TextDecoder` (via ../sse), and `JSON`.
 *
 * Same OAI message conversion, same tool-call accumulation by index,
 * same `usage.include` request for real-dollar cost, same
 * reasoning-token pass-through.
 */
import type { LegacyChatMessage, LegacyToolDecl } from '../types.js';
import type { InferenceEvent, InferenceProvider, NormalizedRequest } from '../types';
import { readSseDataLines } from '../sse';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

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

function toOaiMessages(messages: LegacyChatMessage[]): OaiMessage[] {
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
          id: c.callId,
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
        tool_call_id: m.callId ?? '',
        name: m.name ?? '',
        content: m.resultJson ?? '',
      });
    }
  }
  return out;
}

function toOaiTools(tools: LegacyToolDecl[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
  emitted: boolean;
}

export const openrouterProvider: InferenceProvider = async function* (req: NormalizedRequest) {
  const effort = req.reasoningEffort ?? 'off';
  const body = {
    model: req.model,
    messages: toOaiMessages(req.messages),
    stream: true,
    // Ask OpenRouter to include cost + cached-token telemetry in the
    // final usage chunk.
    usage: { include: true },
    ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(typeof req.topP === 'number' ? { top_p: req.topP } : {}),
    ...(typeof req.topK === 'number' ? { top_k: req.topK } : {}),
    // OpenRouter's unified reasoning parameter:
    //   - `effort: 'off'` → send `reasoning: { enabled: false }`.
    //     Just OMITTING the field doesn't actually disable reasoning
    //     on Anthropic / DeepSeek / GLM / Kimi / MiniMax thinking
    //     models — OpenRouter falls back to each model's default
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
        Authorization: `Bearer ${req.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://pyric-playground.web.app',
        'X-Title': 'Pyric Playground',
      },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });
  } catch (e) {
    if (req.signal?.aborted) return;
    yield { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    yield { kind: 'error', message: `OpenRouter ${response.status}: ${text.slice(0, 240)}` };
    return;
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let costUsd: number | undefined;
  const pending = new Map<number, PendingToolCall>();

  try {
    for await (const payload of readSseDataLines(response.body)) {
      if (payload === '[DONE]') break;
      if (req.signal?.aborted) return;
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
          cost?: number;
        };
      };
      const delta = e.choices?.[0]?.delta;
      if (delta?.content) {
        yield { kind: 'text', chunk: delta.content };
      }
      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (reasoning) {
        yield { kind: 'thinking', chunk: reasoning };
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
        if (typeof e.usage.cost === 'number') costUsd = e.usage.cost;
      }
    }
  } catch (e) {
    if (req.signal?.aborted) return;
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
      callId: p.id || `or_${Math.random().toString(36).slice(2, 10)}`,
      name: p.name,
      args: parsedArgs,
    };
    p.emitted = true;
  }

  yield {
    kind: 'usage',
    promptTokens,
    outputTokens: completionTokens,
    ...(typeof costUsd === 'number' ? { costUsd } : {}),
  };
};
