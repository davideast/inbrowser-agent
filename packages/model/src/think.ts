/**
 * `splitThinking` — stream transformer that splits reasoning-tagged
 * content out of a raw token stream.
 *
 * Reasoning models (DeepSeek R1, R1-Distill-*, some Qwen 3 thinking
 * variants) emit their reasoning trace inside literal tags
 * (`<think>…</think>` by default). The engine itself stays narrow —
 * it just emits `token` events with whatever text the decoder
 * produced. This utility wraps that stream and re-emits the same
 * shape, except text inside the open/close tags is yielded as
 * `kind: 'thinking'` instead of `kind: 'token'`.
 *
 *   for await (const evt of splitThinking(engine.generate(msgs))) {
 *     if (evt.kind === 'thinking') showReasoning(evt.text);
 *     else if (evt.kind === 'token') showOutput(evt.text);
 *   }
 *
 * Tag matching is configurable (defaults to DeepSeek's
 * `<think>` / `</think>`). The implementation buffers up to one
 * tag-length minus one byte so partial tags split across token
 * boundaries (e.g., `<th` then `ink>`) resolve correctly.
 *
 * Pass-through behavior for non-token events: `usage` and `error`
 * forward unchanged so terminal accounting is preserved.
 */

import type { EngineEvent } from './types.js';

export interface ThinkingSplitOpts {
  /** Tag that opens a reasoning block. Default: `<think>`. */
  openTag?: string;
  /** Tag that closes a reasoning block. Default: `</think>`. */
  closeTag?: string;
}

export async function* splitThinking(
  source: AsyncIterable<EngineEvent>,
  opts: ThinkingSplitOpts = {},
): AsyncIterable<EngineEvent> {
  const open = opts.openTag ?? '<think>';
  const close = opts.closeTag ?? '</think>';
  if (open.length === 0 || close.length === 0) {
    throw new Error('splitThinking: openTag and closeTag must be non-empty');
  }

  let mode: 'normal' | 'inside' = 'normal';
  // `buffer` holds text we haven't decided how to emit yet — typically
  // because the trailing characters could be a partial tag prefix.
  let buffer = '';

  for await (const evt of source) {
    if (evt.kind !== 'token') {
      yield evt;
      continue;
    }
    buffer += evt.text;

    // Drain the buffer as far as we can each iteration. We loop because
    // a single token can contain `<think>…</think>` end-to-end; one
    // pass per state transition handles that.
    while (buffer.length > 0) {
      if (mode === 'normal') {
        const idx = buffer.indexOf(open);
        if (idx === -1) {
          // No complete open tag visible. Emit everything except the
          // last (open.length - 1) bytes — those could be a partial
          // tag continuing in the next token. The remainder stays in
          // the buffer.
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
          const safeLen = buffer.length - (close.length - 1);
          if (safeLen > 0) {
            yield { kind: 'thinking', text: buffer.slice(0, safeLen) };
            buffer = buffer.slice(safeLen);
          }
          break;
        }
        if (idx > 0) {
          yield { kind: 'thinking', text: buffer.slice(0, idx) };
        }
        buffer = buffer.slice(idx + close.length);
        mode = 'normal';
      }
    }
  }

  // Flush any residual buffer. If we ended mid-`<think>` block (model
  // hit max_new_tokens before emitting `</think>`), treat the
  // remainder as thinking — the alternative would be silently
  // dropping it.
  if (buffer.length > 0) {
    yield { kind: mode === 'inside' ? 'thinking' : 'token', text: buffer };
  }
}
