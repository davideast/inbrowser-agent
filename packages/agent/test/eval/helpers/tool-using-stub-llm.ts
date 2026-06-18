/**
 * Stateful stub `ModelClient` that emits N tool calls in turn zero and
 * a final-answer turn after. Used to give the strategy something to
 * dispatch so the parallel-dispatch wall-clock effect is observable.
 *
 * State machine:
 *   chat() call #1: yield N `tool_call` events + `usage`, then return
 *   chat() call #2: yield text + `usage`, then return (final turn — no
 *                   tool calls, agent loop terminates)
 *
 * Output varies by trial so within-side spreads are non-zero (no
 * `delta === 0` carve-out for any metric the stub controls).
 */

import type { ModelClient, ModelEvent, ModelRequest } from '../../../src/index.js';

export interface ToolUsingStubOptions {
  toolNames: readonly string[];
  trial: number;
  id?: string;
}

export function createToolUsingStubLlm(options: ToolUsingStubOptions): ModelClient {
  const id = options.id ?? 'tool-using-stub';
  let iteration = 0;
  return {
    id,
    supportsTools: true,
    async *chat(_req: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {
      const current = iteration++;
      if (current === 0) {
        for (let i = 0; i < options.toolNames.length; i++) {
          yield {
            kind: 'tool_call',
            id: `call-${current}-${i}`,
            name: options.toolNames[i] as string,
            args: { trial: options.trial, index: i },
          };
        }
        yield {
          kind: 'usage',
          usage: {
            promptTokens: 100 + options.trial * 5,
            outputTokens: 20 + options.trial * 3,
          },
        };
        return;
      }
      yield {
        kind: 'text',
        text: `Final stub response after tool calls (trial ${options.trial}).`,
      };
      yield {
        kind: 'usage',
        usage: {
          promptTokens: 200 + options.trial * 5,
          outputTokens: 30 + options.trial * 2,
        },
      };
    },
  };
}
