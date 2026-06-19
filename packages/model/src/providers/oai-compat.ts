import type { ModelClient, ModelEvent, ModelMessage, ModelRequest, ToolSpec } from '../contract.js';
import { readSseDataLines } from '../sse.js';
import type { CloudProviderConfig } from './types.js';
/**
 * Shared OpenAI-compatible chat-completions core.
 *
 * Every server that speaks the OpenAI `POST /v1/chat/completions` wire
 * shape — Ollama, llama.cpp's `llama-server`, vLLM, LM Studio, LocalAI,
 * TGI, … — streams the same SSE deltas and reports the same `usage`
 * fields. This module holds that one implementation:
 *
 *   - `toOaiMessages` / `toOaiTools` — translate the unified contract's
 *     messages + nested `ToolSpec` into the OAI wire shape.
 *   - `makeOaiClient` — the streaming engine: builds the request body,
 *     fetches, parses SSE, accumulates tool-calls by index, and emits
 *     `text` / `tool_call` / `usage` / `error` events. It takes
 *     fully-resolved params so each server is just a set of defaults.
 *   - `openaiCompatModelClient` — the public, generic factory. Point it
 *     at any OAI-compatible server via `baseUrl` (or a full `endpoint`).
 *
 * The named presets (`ollamaModelClient`, `llamaServerModelClient`) are
 * thin wrappers that resolve their own port / auth / labels and delegate
 * to `makeOaiClient`. They call the engine directly rather than routing
 * through `openaiCompatModelClient` because their auth rules differ
 * (Ollama carries a base URL in the `apiKey` slot and sends no auth
 * header; the generic factory treats `apiKey` as a Bearer token).
 *
 * Environment-agnostic: the only globals touched are `fetch`,
 * `TextDecoder` (via ../sse), and `JSON`.
 */

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

export function toOaiMessages(messages: ModelMessage[]): OaiMessage[] {
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
        // OAI servers reject assistant messages that carry tool_calls
        // alongside empty-string content — null content is the documented form.
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
 * Trim trailing slashes off a base URL, falling back to `fallback` when
 * the value is empty or not an http(s) URL. Shared by the presets, whose
 * relay-routing path can pass the base URL through the `apiKey` slot.
 */
export function resolveBaseUrl(raw: string | undefined, fallback: string): string {
  return raw && /^https?:\/\//.test(raw) ? raw.replace(/\/+$/, '') : fallback;
}

/** Fully-resolved settings the streaming engine needs. */
export interface OaiClientParams {
  /** Stable id for metrics + provenance, e.g. `ollama:llama3.1`. */
  id: string;
  /** Full chat-completions endpoint, e.g. `http://localhost:8080/v1/chat/completions`. */
  endpoint: string;
  /** Upstream model id sent in the request body. */
  model: string;
  /** Extra request headers (e.g. `Authorization`). `Content-Type` is always set. */
  headers: Record<string, string>;
  /** Human label used in error messages, e.g. `llama-server`. */
  errorLabel: string;
  /** Prefix for synthesized tool-call ids when the server omits one. */
  idPrefix: string;
  /** Extra hint appended to a connection-failure error; receives the base URL. */
  connectHint?: (base: string) => string;
  /** Construction-time temperature default; a per-request value always wins. */
  temperatureDefault?: number;
}

/** Build a `ModelClient` from fully-resolved OAI params. */
export function makeOaiClient(p: OaiClientParams): ModelClient {
  return {
    id: p.id,
    supportsTools: true,
    async *chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      // Per-request temperature wins; otherwise fall back to the
      // construction-time default. The relay sets neither.
      const temperature = req.temperature ?? p.temperatureDefault;
      const body = {
        model: p.model,
        messages: toOaiMessages(req.messages),
        stream: true,
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof req.topP === 'number' ? { top_p: req.topP } : {}),
        ...(typeof req.topK === 'number' ? { top_k: req.topK } : {}),
        ...(req.tools.length > 0
          ? { tools: toOaiTools(req.tools), tool_choice: 'auto' as const }
          : {}),
      };

      let response: Response;
      try {
        response = await fetch(p.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...p.headers },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        if (signal?.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        const base = p.endpoint.replace(/\/v1\/chat\/completions$/, '');
        const hint = p.connectHint ? ` ${p.connectHint(base)}` : '';
        yield { kind: 'error', message: `${p.errorLabel} fetch failed (${msg}).${hint}` };
        return;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        yield {
          kind: 'error',
          message: `${p.errorLabel} ${response.status}: ${text.slice(0, 240)}`,
        };
        return;
      }

      let promptTokens = 0;
      let completionTokens = 0;
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
            };
          };
          const delta = e.choices?.[0]?.delta;
          if (delta?.content) {
            yield { kind: 'text', text: delta.content };
          }
          if (delta?.tool_calls) {
            for (const d of delta.tool_calls) {
              let pc = pending.get(d.index);
              if (!pc) {
                pc = { id: d.id ?? '', name: '', args: '', emitted: false };
                pending.set(d.index, pc);
              }
              if (d.id) pc.id = d.id;
              if (d.function?.name) pc.name = d.function.name;
              if (d.function?.arguments) pc.args += d.function.arguments;
            }
          }
          if (e.usage) {
            promptTokens = e.usage.prompt_tokens ?? promptTokens;
            completionTokens = e.usage.completion_tokens ?? completionTokens;
          }
        }
      } catch (e) {
        if (signal?.aborted) return;
        yield { kind: 'error', message: e instanceof Error ? e.message : String(e) };
        return;
      }

      // Tool calls stream argument-by-argument; emit once after the
      // stream closes so we don't fire on half-parsed JSON.
      for (const pc of pending.values()) {
        if (pc.emitted) continue;
        let parsedArgs: unknown = {};
        try {
          parsedArgs = pc.args ? JSON.parse(pc.args) : {};
        } catch {
          parsedArgs = { _raw: pc.args };
        }
        yield {
          kind: 'tool_call',
          id: pc.id || `${p.idPrefix}_${Math.random().toString(36).slice(2, 10)}`,
          name: pc.name,
          args: parsedArgs,
        };
        pc.emitted = true;
      }

      yield {
        kind: 'usage',
        usage: {
          promptTokens,
          outputTokens: completionTokens,
        },
      };
    },
  };
}

const DEFAULT_BASE_URL = 'http://localhost:8080';

/**
 * Construction config for the generic OpenAI-compatible provider. Extends
 * the shared cloud config with optional wire overrides:
 *   - `baseUrl`  — server URL; `/v1/chat/completions` is appended. Defaults
 *                  to `http://localhost:8080` (the common local-server port).
 *   - `endpoint` — full chat-completions URL; overrides `baseUrl` entirely.
 *   - `apiKey`   — sent as `Authorization: Bearer <key>` unless an explicit
 *                  `Authorization` header is supplied in `headers`.
 *   - `headers`  — extra request headers (override the derived ones).
 *   - `id`       — metrics id; defaults to `openai:<model>`.
 *   - `label`    — error-message label; defaults to `OpenAI-compatible server`.
 */
export interface OpenAiCompatConfig extends CloudProviderConfig {
  endpoint?: string;
  headers?: Record<string, string>;
  id?: string;
  label?: string;
}

/**
 * Build a `ModelClient` for any OpenAI-compatible chat-completions server.
 * Construction values (baseUrl/endpoint, apiKey, model, headers) come in
 * the config; per-call values (messages, tools, sampling) come in the
 * `ModelRequest`.
 */
export function openaiCompatModelClient(config: OpenAiCompatConfig): ModelClient {
  const endpoint =
    config.endpoint ?? `${resolveBaseUrl(config.baseUrl, DEFAULT_BASE_URL)}/v1/chat/completions`;
  const headers: Record<string, string> = {
    // OAI servers expect a Bearer token; explicit headers win so callers
    // can override the scheme (or clear it) when a server differs.
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
  };
  return makeOaiClient({
    id: config.id ?? `openai:${config.model}`,
    endpoint,
    model: config.model,
    headers,
    errorLabel: config.label ?? 'OpenAI-compatible server',
    idPrefix: 'oai',
    temperatureDefault: config.temperature,
  });
}
