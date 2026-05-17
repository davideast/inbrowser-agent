/**
 * Deterministic stub `LlmClient` for harness smoke tests.
 *
 * Emits one turn with no tool calls: a few text chunks, a
 * `turn_complete` event with a hand-picked `RawUsage`, then returns.
 * The agent loop sees zero tool calls and terminates the turn as the
 * final-answer turn.
 *
 * Output varies by trial number so multi-trial aggregations have
 * non-zero spread (the smoke test exercises the no-effect rule, not
 * just the `delta === 0` carve-out).
 */

import type { ChatEvent, ChatRequest, LlmClient } from '../../../src/index.js';

export interface StubLlmOptions {
  /** Zero-indexed trial number, used to vary the deterministic output. */
  trial: number;
  /** Identifier echoed on `LlmClient.id` and in `TurnDetails.requestedModel`. */
  id?: string;
}

export function createStubLlm(options: StubLlmOptions): LlmClient {
  const trial = options.trial;
  const id = options.id ?? 'stub';
  return {
    id,
    supportsTools: true,
    async *chat(_req: ChatRequest, _signal: AbortSignal): AsyncIterable<ChatEvent> {
      // Vary text length by trial so within-run spreads are non-zero.
      const padding = '.'.repeat(8 + trial * 4);
      yield {
        kind: 'text',
        chunk: `Stub assistant response (trial ${trial}). ${padding}`,
      };
      yield {
        kind: 'text',
        chunk: ' Acknowledged the prompt without invoking tools.',
      };
      yield {
        kind: 'turn_complete',
        usage: {
          promptTokens: 100 + trial * 10,
          completionTokens: 20 + trial * 5,
        },
        details: { requestedModel: id },
      };
    },
  };
}
