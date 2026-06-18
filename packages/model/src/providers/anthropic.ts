import type { ModelClient, ModelEvent, ModelMessage, ModelRequest, ToolSpec } from '../contract.js';
import { readSseDataLines } from '../sse.js';
import type { CloudProviderConfig } from './types.js';
/**
 * Anthropic provider — talks to Anthropic's native Messages API
 * (`POST /v1/messages` with `stream: true`).
 *
 * This provider exists as much for documentation as for use: it
 * proves the `ModelClient` contract is sufficient for a third party.
 * Adding Anthropic native required ZERO relay changes — the file
 * imports nothing private from `@inbrowser/relay`, just the shared
 * `ModelClient` contract + the shared `readSseDataLines` helper.
 *
 * Endpoint: POST https://api.anthropic.com/v1/messages
 *   - header `x-api-key` carries the BYOK key
 *   - header `anthropic-version: 2023-06-01`
 *   - body `{ model, messages, stream: true, max_tokens, system? }`
 *
 * The wire shape Anthropic streams is documented at
 * https://docs.anthropic.com/en/api/messages-streaming — this
 * provider handles the subset used by simple text + tool-use
 * generations.
 *
 * Tool use is wired but minimally tested. Production users with
 * complex tool flows may want to extend this — the file is
 * intentionally compact so it's easy to fork.
 */

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
/** Anthropic requires `max_tokens` on every request. 8192 is the
 *  current per-request max for most Claude models — well above any
 *  realistic completion length. */
const MAX_TOKENS = 8192;

/** Construction config for the Anthropic provider. */
export interface AnthropicConfig extends CloudProviderConfig {}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
        | { type: 'tool_result'; tool_use_id: string; content: string }
      >;
}

interface AnthropicBody {
  model: string;
  messages: AnthropicMessage[];
  stream: true;
  max_tokens: number;
  system?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: unknown;
  }>;
}

function toAnthropic(messages: ModelMessage[]): {
  system: string;
  msgs: AnthropicMessage[];
} {
  let system = '';
  const msgs: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + (m.text ?? '');
      continue;
    }
    if (m.role === 'user') {
      msgs.push({ role: 'user', content: m.text ?? '' });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: Extract<AnthropicMessage['content'], unknown[]> = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: c.id,
          name: c.name,
          input: c.args ?? {},
        });
      }
      msgs.push({
        role: 'assistant',
        content: blocks.length > 0 ? blocks : '',
      });
      continue;
    }
    if (m.role === 'tool') {
      msgs.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId ?? '',
            content: m.resultJson ?? '',
          },
        ],
      });
    }
  }
  return { system, msgs };
}

export function toAnthropicTools(tools: ToolSpec[]): AnthropicBody['tools'] {
  if (tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

interface PendingToolUse {
  id: string;
  name: string;
  inputBuf: string;
}

/**
 * Build an Anthropic `ModelClient`. Construction values (apiKey,
 * model) come in the config; per-call values (messages, tools,
 * sampling) come in the `ModelRequest`.
 */
export function anthropicModelClient(config: AnthropicConfig): ModelClient {
  return {
    id: `anthropic:${config.model}`,
    supportsTools: true,
    async *chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      const { system, msgs } = toAnthropic(req.messages);
      // Per-request temperature wins; otherwise fall back to the
      // construction-time default. Relay sets neither.
      const temperature = req.temperature ?? config.temperature;
      const body: AnthropicBody = {
        model: config.model,
        messages: msgs,
        stream: true,
        max_tokens: MAX_TOKENS,
        ...(system ? { system } : {}),
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof req.topP === 'number' ? { top_p: req.topP } : {}),
        ...(typeof req.topK === 'number' ? { top_k: req.topK } : {}),
        ...(req.tools.length > 0 ? { tools: toAnthropicTools(req.tools) } : {}),
      };

      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            // Relay guarantees a resolved key before the provider runs
            // (BYOK 400s if missing; server-managed injects). `?? ''`
            // satisfies the string type for the now-optional field.
            'x-api-key': config.apiKey ?? '',
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json',
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
        yield {
          kind: 'error',
          message: `Anthropic ${response.status}: ${text.slice(0, 240)}`,
        };
        return;
      }

      let promptTokens = 0;
      let outputTokens = 0;
      const pending = new Map<number, PendingToolUse>();

      try {
        for await (const payload of readSseDataLines(response.body)) {
          if (signal?.aborted) return;
          let evt: {
            type: string;
            index?: number;
            delta?: {
              type?: string;
              text?: string;
              partial_json?: string;
            };
            content_block?: {
              type: string;
              id?: string;
              name?: string;
            };
            message?: {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
              };
            };
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
            };
          };
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }

          if (evt.type === 'message_start' && evt.message?.usage) {
            promptTokens = evt.message.usage.input_tokens ?? 0;
            outputTokens = evt.message.usage.output_tokens ?? 0;
          } else if (
            evt.type === 'content_block_start' &&
            evt.content_block?.type === 'tool_use' &&
            typeof evt.index === 'number'
          ) {
            pending.set(evt.index, {
              id: evt.content_block.id ?? '',
              name: evt.content_block.name ?? '',
              inputBuf: '',
            });
          } else if (evt.type === 'content_block_delta' && evt.delta) {
            if (evt.delta.type === 'text_delta' && typeof evt.delta.text === 'string') {
              yield { kind: 'text', text: evt.delta.text };
            } else if (
              evt.delta.type === 'input_json_delta' &&
              typeof evt.delta.partial_json === 'string' &&
              typeof evt.index === 'number'
            ) {
              const p = pending.get(evt.index);
              if (p) p.inputBuf += evt.delta.partial_json;
            }
          } else if (evt.type === 'message_delta' && evt.usage) {
            outputTokens = evt.usage.output_tokens ?? outputTokens;
          }
        }
      } catch (e) {
        if (signal?.aborted) return;
        yield { kind: 'error', message: e instanceof Error ? e.message : String(e) };
        return;
      }

      // Flush any accumulated tool_use blocks.
      for (const p of pending.values()) {
        let parsed: unknown = {};
        try {
          parsed = p.inputBuf ? JSON.parse(p.inputBuf) : {};
        } catch {
          parsed = { _raw: p.inputBuf };
        }
        yield {
          kind: 'tool_call',
          id: p.id || `anth_${Math.random().toString(36).slice(2, 10)}`,
          name: p.name,
          args: parsed,
        };
      }

      yield {
        kind: 'usage',
        usage: {
          promptTokens,
          outputTokens,
        },
      };
    },
  };
}
