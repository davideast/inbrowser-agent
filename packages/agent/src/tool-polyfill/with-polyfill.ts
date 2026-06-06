import type { NormalizedMessage } from '../types/chat.js';
import type { ChatEvent, ChatRequest, LlmClient } from '../types/llm.js';
import { encodeHistory } from './encode-history.js';
import { parseToolCallStream } from './parse-stream.js';
import { buildGemma4SystemPrompt } from './prompt.js';
import type { ToolUsePolyfillOpts } from './types.js';

/**
 * Wrap any `LlmClient` so it reports `supportsTools: true` even when the
 * underlying model has no native tool-calling support.
 *
 * The wrapper:
 *   1. Injects a system-prompt addendum that describes the available tools
 *      and the expected `<tool_call name="X">{…}</tool_call>` envelope.
 *   2. Encodes any prior native toolCalls / tool-result messages into text
 *      envelopes the model recognizes.
 *   3. Calls the inner client with `tools: []` / `toolUseEnabled: false`.
 *   4. Parses the text output for tool-call envelopes and emits synthetic
 *      `tool_call` events in their place.
 *   5. Retries when `noToolStrategy: 'retry'` and the model produced no calls.
 *
 * Pass-through: when `toolUseEnabled === false` or `tools` is empty, the
 * request is forwarded to the inner client unchanged — no overhead.
 */
export function withToolUsePolyfill(inner: LlmClient, opts: ToolUsePolyfillOpts = {}): LlmClient {
  const maxRetries = opts.maxRetries ?? 1;
  const noToolStrategy = opts.noToolStrategy ?? 'allow';
  const malformedArgsStrategy = opts.malformedArgsStrategy ?? 'best-effort';
  const buildSystemPrompt = opts.buildSystemPrompt ?? buildGemma4SystemPrompt;

  return {
    id: inner.id,
    supportsTools: true,
    chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      return run(req, signal);
    },
  };

  async function* run(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    if (!req.toolUseEnabled || req.tools.length === 0) {
      yield* inner.chat(req, signal);
      return;
    }

    const addendum = buildSystemPrompt(req.tools);
    let messages: NormalizedMessage[] = injectSystemPrompt(encodeHistory(req.messages), addendum);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal.aborted) {
        yield { kind: 'error', message: 'aborted' };
        return;
      }

      const innerReq: ChatRequest = {
        ...req,
        messages,
        tools: [],
        toolUseEnabled: false,
      };

      const events: ChatEvent[] = [];
      let hasToolCall = false;

      for await (const ev of parseToolCallStream(inner.chat(innerReq, signal), req.tools, {
        malformedArgsStrategy,
      })) {
        events.push(ev);
        if (ev.kind === 'tool_call') hasToolCall = true;
      }

      if (!hasToolCall && noToolStrategy === 'retry' && attempt < maxRetries) {
        const assistantText = events
          .filter((e): e is Extract<ChatEvent, { kind: 'text' }> => e.kind === 'text')
          .map((e) => e.chunk)
          .join('');
        messages = [
          ...messages,
          { role: 'assistant', text: assistantText },
          {
            role: 'user',
            text: 'Please use one of the available tools. Emit a <tool_call> tag exactly as shown in the instructions.',
          },
        ];
        continue;
      }

      for (const ev of events) yield ev;
      break;
    }
  }
}

function injectSystemPrompt(
  messages: ReadonlyArray<NormalizedMessage>,
  addendum: string,
): NormalizedMessage[] {
  const idx = messages.findIndex((m) => m.role === 'system');
  if (idx >= 0) {
    const sys = messages[idx]!;
    return [
      ...messages.slice(0, idx),
      { ...sys, text: sys.text ? `${sys.text}\n\n${addendum}` : addendum },
      ...messages.slice(idx + 1),
    ];
  }
  return [{ role: 'system', text: addendum }, ...messages];
}
