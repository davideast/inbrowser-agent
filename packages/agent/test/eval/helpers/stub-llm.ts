/**
 * Deterministic stub `ModelClient` for harness smoke tests.
 *
 * Emits one turn with no tool calls: a few text chunks, a `usage`
 * event with a hand-picked `ModelUsage`, then returns. The turn ends
 * when the iterable returns; the agent loop sees zero tool calls and
 * terminates the turn as the final-answer turn.
 *
 * Output varies by trial number so multi-trial aggregations have
 * non-zero spread (the smoke test exercises the no-effect rule, not
 * just the `delta === 0` carve-out).
 */

import type { ModelClient, ModelEvent, ModelRequest } from '../../../src/index.js';

export interface StubLlmOptions {
  /** Zero-indexed trial number, used to vary the deterministic output. */
  trial: number;
  /** Identifier echoed on `ModelClient.id` and in `TurnDetails.requestedModel`. */
  id?: string;
}

export function createStubLlm(options: StubLlmOptions): ModelClient {
  const trial = options.trial;
  const id = options.id ?? 'stub';
  return {
    id,
    supportsTools: true,
    async *chat(_req: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {
      // Vary text length by trial so within-run spreads are non-zero.
      const padding = '.'.repeat(8 + trial * 4);
      yield {
        kind: 'text',
        text: `Stub assistant response (trial ${trial}). ${padding}`,
      };
      yield {
        kind: 'text',
        text: ' Acknowledged the prompt without invoking tools.',
      };
      yield {
        kind: 'usage',
        usage: {
          promptTokens: 100 + trial * 10,
          outputTokens: 20 + trial * 5,
        },
      };
    },
  };
}
