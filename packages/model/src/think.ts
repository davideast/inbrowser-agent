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
  /**
   * When true, the stream is treated as starting *inside* the
   * thinking channel — i.e., the opening tag is implicit. The first
   * `closeTag` ends the block; subsequent text streams as `token`.
   *
   * Used for models where the chat template's `add_generation_prompt`
   * pre-fills the opening marker, so generation begins inside
   * thinking and the model only emits the close marker explicitly.
   * Gemma 4 family works this way.
   *
   * Default: `false`.
   */
  implicitOpen?: boolean;
  /**
   * Literal substrings to strip from `token` events post-parse.
   * Useful for cleaning up structural leak tokens that appear when
   * the engine sets `skip_special_tokens: false` to expose channel
   * markers (Gemma 4's `<turn|>` end-of-turn marker, for example).
   *
   * Stripping is applied AFTER mode classification — content inside
   * thinking blocks is not affected. Default: `[]`.
   */
  stripTokens?: ReadonlyArray<string>;
}

export async function* splitThinking(
  source: AsyncIterable<EngineEvent>,
  opts: ThinkingSplitOpts = {},
): AsyncIterable<EngineEvent> {
  const open = opts.openTag ?? '<think>';
  const close = opts.closeTag ?? '</think>';
  const implicitOpen = opts.implicitOpen ?? false;
  const stripTokens = opts.stripTokens ?? [];
  if (close.length === 0) {
    throw new Error('splitThinking: closeTag must be non-empty');
  }
  if (!implicitOpen && open.length === 0) {
    throw new Error('splitThinking: openTag must be non-empty unless implicitOpen is true');
  }

  // Initial state: when `implicitOpen` is true, the stream is treated
  // as already inside the thinking block (Gemma 4: chat template
  // primes generation inside <|channel>thought, so the first emitted
  // token IS thinking content). Otherwise start in `normal` and wait
  // for the open tag.
  let mode: 'normal' | 'inside' = implicitOpen ? 'inside' : 'normal';
  // `buffer` holds text we haven't decided how to emit yet — typically
  // because the trailing characters could be a partial tag prefix OR
  // a partial stripToken.
  let buffer = '';

  // Holdback: how many trailing bytes to keep in the buffer rather
  // than emit, so partial matches (open-tag prefix, or any
  // stripToken split across input boundaries) can resolve on a
  // subsequent input chunk.
  //
  //   - openTag protection: keep up to `open.length - 1` chars so a
  //     partial open-tag like `<thi` resolves when `nk>` arrives.
  //   - stripToken protection: keep up to `maxStripLen` chars (NOT
  //     `maxStripLen - 1`) so a stripToken that *starts* near the
  //     boundary is fully held back rather than split. Splitting would
  //     mean the literal-substring `includes(t)` check fails on both
  //     halves and the token leaks.
  const holdbackForOpen = open.length > 0 ? open.length - 1 : 0;
  const holdbackForStrip =
    stripTokens.length > 0 ? Math.max(...stripTokens.map((t) => t.length)) : 0;
  const holdback = Math.max(holdbackForOpen, holdbackForStrip);

  // Helper: emit a token event with the configured strip-tokens applied.
  function emitToken(text: string): EngineEvent {
    let cleaned = text;
    for (const t of stripTokens) {
      if (cleaned.includes(t)) cleaned = cleaned.split(t).join('');
    }
    return { kind: 'token', text: cleaned };
  }

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
        // In normal mode we look for the next open tag (if defined).
        // When openTag is empty (implicitOpen-with-no-return), we
        // still need to respect stripToken holdback so partial
        // stripTokens don't sneak past us at input-chunk boundaries.
        const idx = open.length > 0 ? buffer.indexOf(open) : -1;
        if (idx === -1) {
          // No open tag visible. Emit buffer minus the holdback
          // window so partial open-tag / stripToken matches resolve
          // on the next input.
          const safeLen = buffer.length - holdback;
          if (safeLen > 0) {
            yield emitToken(buffer.slice(0, safeLen));
            buffer = buffer.slice(safeLen);
          }
          break;
        }
        if (idx > 0) {
          yield emitToken(buffer.slice(0, idx));
        }
        buffer = buffer.slice(idx + open.length);
        mode = 'inside';
      } else {
        const idx = buffer.indexOf(close);
        if (idx === -1) {
          // Holdback for close-tag protection inside thinking. We
          // don't need stripToken holdback here — stripTokens apply
          // to token events, not thinking events.
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

  // Flush any residual buffer. If we ended mid-thinking-block (model
  // hit max_new_tokens before the close, OR implicitOpen never saw a
  // close), treat the remainder as thinking — alternative would be
  // silently dropping it.
  if (buffer.length > 0) {
    if (mode === 'inside') {
      yield { kind: 'thinking', text: buffer };
    } else {
      yield emitToken(buffer);
    }
  }
}
