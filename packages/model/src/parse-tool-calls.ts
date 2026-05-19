/**
 * `parseToolCalls` — stream transformer that detects native
 * tool-call envelopes the model emits and re-emits them as
 * `kind: 'tool_call'` engine events.
 *
 * Different model families use different envelope formats:
 *
 *   Qwen 2/3, DeepSeek R1, Hermes-Pro:
 *     <tool_call>
 *     {"name": "func", "arguments": {...}}
 *     </tool_call>
 *
 *   Llama 3.2+ (not yet supported — uses special tokens):
 *     <|python_tag|>{"name": "func", "parameters": {...}}<|eom_id|>
 *
 *   Mistral v0.3+ (not yet supported):
 *     [TOOL_CALLS]{"name": "func", "arguments": {...}}[/TOOL_CALLS]
 *
 * Default format is `'qwen'` (handles Qwen 2/3, DeepSeek R1, Hermes).
 * Add new formats by extending the format union.
 *
 * The implementation is a buffer-aware state machine mirroring
 * `splitThinking` — partial tags split across token boundaries
 * resolve correctly. Inside-tag content is parsed as JSON to extract
 * `name` and `arguments`; on parse failure the args field carries
 * `{ _raw: string }` so the caller can surface or salvage.
 *
 * Pass-through behavior: `thinking`, `usage`, and `error` events
 * forward unchanged. `token` events outside an envelope forward as
 * `token`; inside an envelope they're buffered and converted to a
 * single `tool_call` event on close.
 */

import type { EngineEvent } from './types.js';

export interface ToolCallParseOpts {
  /**
   * Envelope format. Default `'qwen'` — `<tool_call>...</tool_call>`
   * with a JSON body containing `name` and `arguments`. The body's
   * JSON is parsed on close; malformed JSON falls through as
   * `{ args: { _raw: string } }` so consumers can salvage or surface.
   */
  format?: 'qwen';
  /**
   * Override id generator. Default uses a short random suffix.
   * Useful for tests that need deterministic ids.
   */
  generateId?: () => string;
}

const DEFAULT_OPEN_TAG = '<tool_call>';
const DEFAULT_CLOSE_TAG = '</tool_call>';

function defaultId(): string {
  return `tc_${Math.random().toString(36).slice(2, 10)}`;
}

interface ParsedBody {
  name: string;
  args: unknown;
}

function parseQwenBody(body: string): ParsedBody {
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed) as { name?: unknown; arguments?: unknown };
    const name = typeof parsed.name === 'string' ? parsed.name : '';
    // Some templates use `arguments`, some use `parameters`. Accept
    // both as a small charitable coercion — the model occasionally
    // mis-keys.
    const args =
      parsed.arguments !== undefined
        ? parsed.arguments
        : ((parsed as { parameters?: unknown }).parameters ?? {});
    return { name, args };
  } catch {
    return { name: '', args: { _raw: trimmed } };
  }
}

export async function* parseToolCalls(
  source: AsyncIterable<EngineEvent>,
  opts: ToolCallParseOpts = {},
): AsyncIterable<EngineEvent> {
  const open = DEFAULT_OPEN_TAG;
  const close = DEFAULT_CLOSE_TAG;
  const genId = opts.generateId ?? defaultId;

  let mode: 'normal' | 'inside' = 'normal';
  let buffer = '';

  for await (const evt of source) {
    if (evt.kind !== 'token') {
      yield evt;
      continue;
    }
    buffer += evt.text;

    while (buffer.length > 0) {
      if (mode === 'normal') {
        const idx = buffer.indexOf(open);
        if (idx === -1) {
          // Hold back the tail in case it's a partial open-tag prefix.
          const safeLen = buffer.length - (open.length - 1);
          if (safeLen > 0) {
            yield { kind: 'token', text: buffer.slice(0, safeLen) };
            buffer = buffer.slice(safeLen);
          }
          break;
        }
        if (idx > 0) {
          yield { kind: 'token', text: buffer.slice(0, idx) };
        }
        buffer = buffer.slice(idx + open.length);
        mode = 'inside';
      } else {
        const idx = buffer.indexOf(close);
        if (idx === -1) {
          // Don't dribble out partial tool-call body — wait for the
          // close tag so we emit one tool_call event per envelope.
          // Trade-off: we hold the entire body in `buffer` until close.
          // Tool-call bodies are small (~hundreds of bytes), fine.
          break;
        }
        const body = buffer.slice(0, idx);
        const { name, args } = parseQwenBody(body);
        yield { kind: 'tool_call', id: genId(), name, args };
        buffer = buffer.slice(idx + close.length);
        mode = 'normal';
      }
    }
  }

  // Flush. If we ended mid-envelope (model hit max_new_tokens before
  // closing), parse whatever body we have and emit it — same
  // best-effort posture as splitThinking.
  if (buffer.length > 0) {
    if (mode === 'inside') {
      const { name, args } = parseQwenBody(buffer);
      yield { kind: 'tool_call', id: genId(), name, args };
    } else {
      yield { kind: 'token', text: buffer };
    }
  }
}
