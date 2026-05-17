/**
 * OpenRouter `LlmClient` for the CLI's `agent run`.
 *
 * Distinct from the playground's `openrouterProvider` in
 * `examples/admin-compat-browser/src/openrouter.ts` (which is browser-
 * specific — reads keys from localStorage, surfaces BYOK forms, etc.).
 * This module is CLI-native: it takes its config explicitly at
 * construction time (no env-var sniffing here — the caller decides
 * how to source the key) and implements the narrow `LlmClient`
 * contract that `@inbrowser/agent`' strategy + session expect.
 *
 * Streams via OpenAI-compatible SSE. Function-calling supported via
 * `tools` + `tool_choice: 'auto'`. Reasoning surfaced through
 * `reasoning.effort` + `include_reasoning` headers for models that
 * carry extended thinking (GLM, DeepSeek-R1, Claude, GPT reasoning
 * models). Cost surfaced through OpenRouter's per-call `usage.cost`
 * field so the agent's `MetricsCollector` doesn't need a per-model
 * pricing table for OpenRouter-served models.
 */

import type { NormalizedMessage, TurnDetails } from '../../types/chat.js';
import type { ChatEvent, ChatRequest, LlmClient, RawUsage } from '../../types/llm.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterConfig {
  apiKey: string;
  /** OpenRouter model id, e.g. `z-ai/glm-4.6`. */
  model: string;
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high';
  /** Override the endpoint (e.g. for an OpenAI-compatible proxy). */
  baseUrl?: string;
  /** Optional referer / title headers OpenRouter shows on the dashboard. */
  referer?: string;
  title?: string;
}

export function openRouterClient(config: OpenRouterConfig): LlmClient {
  const endpoint = config.baseUrl ?? ENDPOINT;
  const effort = config.reasoningEffort ?? 'off';

  return {
    id: `openrouter:${config.model}`,
    supportsTools: true,

    async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      const messages = toOaiMessages(req.messages);
      const tools =
        req.toolUseEnabled && req.tools.length > 0
          ? req.tools.map((t) => ({
              type: 'function' as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            }))
          : undefined;

      const body: Record<string, unknown> = {
        model: config.model,
        messages,
        stream: true,
        ...(tools ? { tools, tool_choice: 'auto' } : {}),
        ...(effort !== 'off'
          ? {
              reasoning: { effort, summary: 'auto' },
              include_reasoning: true,
            }
          : {}),
      };

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      };
      if (config.referer) headers['http-referer'] = config.referer;
      if (config.title) headers['x-title'] = config.title;

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        yield { kind: 'error', message: `OpenRouter network error: ${errMsg(err)}` };
        return;
      }

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        yield {
          kind: 'error',
          message: `OpenRouter ${res.status}: ${detail || res.statusText}`,
        };
        return;
      }

      // Accumulators for the streaming turn.
      const details: TurnDetails = { requestedModel: config.model };
      const toolBuf = new Map<number, { id: string; name: string; argsBuf: string }>();
      let usage: RawUsage | undefined;
      let aborted = false;

      try {
        for await (const chunk of streamSse(res.body, signal)) {
          if (signal.aborted) {
            aborted = true;
            break;
          }
          const c = chunk as OaiChunk;

          // Provenance — last-write-wins. The fields the agent's
          // TurnDetails actually carries are `servedModel`,
          // `fingerprint`, and free-form `routing`; OpenRouter's
          // response id goes into routing alongside any other
          // provider-specific signals.
          if (c.model && !details.servedModel) details.servedModel = c.model;
          if (c.system_fingerprint && !details.fingerprint) {
            details.fingerprint = c.system_fingerprint;
          }
          if (c.id) {
            details.routing = { ...(details.routing ?? {}), responseId: c.id };
          }

          const choice = c.choices?.[0];
          if (choice) {
            const delta = choice.delta ?? {};
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              yield { kind: 'text', chunk: delta.content };
            }
            // Reasoning: flat string OR structured array. Both → thinking events.
            // Reasoning surface — providers send ONE of three shapes per
            // chunk, but some (e.g. GLM) send both `reasoning` and
            // `reasoning_content` for legacy-proxy compat. Pick the
            // first non-empty shape and ignore the rest, otherwise the
            // thinking pane shows every token twice. Matches the
            // playground's openrouter.ts ordering.
            const thinkingChunk = pickReasoning(
              delta.reasoning,
              delta.reasoning_content,
              delta.reasoning_details,
            );
            if (thinkingChunk) yield { kind: 'thinking', chunk: thinkingChunk };
            // Tool calls — accumulated per index, emitted at finish.
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const i = tc.index;
                const slot = toolBuf.get(i) ?? { id: '', name: '', argsBuf: '' };
                if (tc.id) slot.id = tc.id;
                if (tc.function?.name) slot.name = tc.function.name;
                if (tc.function?.arguments) slot.argsBuf += tc.function.arguments;
                toolBuf.set(i, slot);
              }
            }
          }
          if (c.usage) {
            usage = {
              promptTokens: c.usage.prompt_tokens ?? 0,
              completionTokens: c.usage.completion_tokens ?? 0,
              ...(c.usage.prompt_tokens_details?.cached_tokens !== undefined
                ? { cachedTokens: c.usage.prompt_tokens_details.cached_tokens }
                : {}),
              ...(c.usage.cost !== undefined ? { costUsd: c.usage.cost } : {}),
            };
          }
        }
      } catch (err) {
        if (signal.aborted) {
          aborted = true;
        } else {
          yield { kind: 'error', message: `OpenRouter stream error: ${errMsg(err)}` };
          return;
        }
      }

      // Emit accumulated tool calls before the turn-complete sentinel.
      for (const slot of toolBuf.values()) {
        if (!slot.name) continue;
        let args: unknown = slot.argsBuf;
        if (slot.argsBuf.length > 0) {
          try {
            args = JSON.parse(slot.argsBuf);
          } catch {
            // Leave as raw string; let the dispatcher surface the parse error.
          }
        } else {
          args = {};
        }
        yield {
          kind: 'tool_call',
          id: slot.id || `tc_${Math.random().toString(36).slice(2, 10)}`,
          name: slot.name,
          args,
        };
      }

      if (aborted) {
        yield { kind: 'error', message: 'OpenRouter stream aborted' };
        return;
      }

      yield {
        kind: 'turn_complete',
        usage: usage ?? { promptTokens: 0, completionTokens: 0 },
        details,
      };
    },
  };
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Pick the right reasoning surface from a chunk. Providers can fill
 * `delta.reasoning` (flat string — DeepSeek-R1, Claude, GLM, Kimi,
 * Minimax), `delta.reasoning_content` (legacy alias some proxies
 * still emit alongside `reasoning`), or `delta.reasoning_details[]`
 * (structured — OpenAI GPT-5 series). Returns the first non-empty
 * value found; subsequent ones are dropped to avoid duplicated
 * thinking output.
 */
function pickReasoning(
  flat: string | undefined,
  alias: string | undefined,
  details: Array<{ type?: string; summary?: string; text?: string }> | undefined,
): string | null {
  if (typeof flat === 'string' && flat.length > 0) return flat;
  if (typeof alias === 'string' && alias.length > 0) return alias;
  if (Array.isArray(details)) {
    const parts: string[] = [];
    for (const r of details) {
      const text = r.summary ?? r.text;
      if (typeof text === 'string' && text.length > 0) parts.push(text);
    }
    if (parts.length > 0) return parts.join('');
  }
  return null;
}

function toOaiMessages(messages: NormalizedMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: m.resultJson ?? '',
        tool_call_id: m.callId ?? '',
      });
      continue;
    }
    const msg: OaiMessage = { role: m.role, content: m.text };
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      msg.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.callId,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
      }));
    }
    out.push(msg);
  }
  return out;
}

interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

interface OaiChunk {
  id?: string;
  model?: string;
  system_fingerprint?: string;
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      reasoning_details?: Array<{ type?: string; summary?: string; text?: string }>;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Async iterator over OpenAI-compatible SSE chunks. Yields parsed JSON
 * objects, stops on `data: [DONE]`. Lines that aren't `data: ...` or
 * that fail to parse are silently dropped — the OpenAI streaming spec
 * permits comments + heartbeats.
 */
async function* streamSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE messages are separated by blank lines. Process complete
      // events; keep the trailing partial in the buffer.
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const rawLine = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!rawLine.startsWith('data:')) continue;
        const payload = rawLine.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload);
        } catch {
          // Drop malformed chunk; keep streaming.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
