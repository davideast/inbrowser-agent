import { readSseDataLines } from '../sse.js';
import type { InferenceEvent, InferenceProvider, NormalizedRequest } from '../types.js';
/**
 * Ollama provider — talks to a locally-running Ollama server's
 * OAI-compatible endpoint (`${baseUrl}/v1/chat/completions`). Default
 * baseUrl is `http://localhost:11434` but the caller passes their
 * own via `NormalizedRequest.apiKey` (the playground's BYOK slot for
 * Ollama is `kind: 'baseUrl'`; its `getKey()` returns the user-
 * configured URL or the default).
 *
 * Environment-agnostic like the OpenRouter adapter. Same OAI message
 * shape, same tool-call accumulation by index, same SSE parsing. Two
 * notable differences:
 *
 *   - No `Authorization` header (Ollama doesn't authenticate).
 *   - No `usage.include` / `reasoning` config — Ollama doesn't
 *     expose cost or a unified reasoning API. Token counts arrive
 *     in the final SSE event's `prompt_eval_count` /
 *     `eval_count` fields (Ollama's native shape, which the OAI
 *     endpoint preserves alongside `usage`).
 *
 * CORS: Ollama doesn't set CORS headers by default. Browser-side
 * users must run Ollama with `OLLAMA_ORIGINS` set to allow the
 * playground origin (typically `*` for local development). The
 * playground surfaces this warning inline in its BYOK form.
 */
import type { LegacyChatMessage, LegacyToolDecl } from '../types.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';

function resolveEndpoint(apiKey: string): string {
  // The playground passes the baseUrl through req.apiKey. Trim
  // trailing slashes so `/v1/chat/completions` concatenates cleanly.
  // Fall back to the documented default when the slot is empty.
  const baseUrl =
    apiKey && /^https?:\/\//.test(apiKey) ? apiKey.replace(/\/+$/, '') : DEFAULT_BASE_URL;
  return `${baseUrl}/v1/chat/completions`;
}

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

export const ollamaProvider: InferenceProvider = async function* (req: NormalizedRequest) {
  const endpoint = resolveEndpoint(req.apiKey);
  const body = {
    model: req.model,
    messages: toOaiMessages(req.messages),
    stream: true,
    ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(typeof req.topP === 'number' ? { top_p: req.topP } : {}),
    ...(typeof req.topK === 'number' ? { top_k: req.topK } : {}),
    ...(req.tools.length > 0 ? { tools: toOaiTools(req.tools), tool_choice: 'auto' as const } : {}),
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });
  } catch (e) {
    if (req.signal?.aborted) return;
    const msg = e instanceof Error ? e.message : String(e);
    // Common failure: Ollama isn't running OR CORS isn't configured.
    // Browser fetch can't distinguish the two cleanly; surface a
    // hint that covers both.
    yield {
      kind: 'error',
      message: `Ollama fetch failed (${msg}). Confirm \`ollama serve\` is running at ${endpoint.replace(/\/v1\/chat\/completions$/, '')} and that OLLAMA_ORIGINS permits this origin.`,
    };
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    yield { kind: 'error', message: `Ollama ${response.status}: ${text.slice(0, 240)}` };
    return;
  }

  let promptTokens = 0;
  let completionTokens = 0;
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
        yield { kind: 'text', chunk: delta.content };
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
      }
    }
  } catch (e) {
    if (req.signal?.aborted) return;
    yield { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    return;
  }

  // Tool calls stream argument-by-argument; emit once after the
  // stream closes so we don't fire on half-parsed JSON.
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
      callId: p.id || `oll_${Math.random().toString(36).slice(2, 10)}`,
      name: p.name,
      args: parsedArgs,
    };
    p.emitted = true;
  }

  yield {
    kind: 'usage',
    promptTokens,
    outputTokens: completionTokens,
  };
};
