/**
 * Adapt an on-device `Engine` to `@inbrowser/relay`'s
 * `InferenceProvider`. Lets the relay's existing handlers, durable
 * storage, and SSE wire format treat a local Gemma model
 * indistinguishably from Gemini-over-HTTP.
 *
 * `NormalizedRequest` fields with no on-device analogue (`apiKey`,
 * `provider`, `model` routing) are ignored — the engine is already
 * bound to a single model at construction time.
 *
 * `@inbrowser/relay` is a peer dep; this subpath is the only point
 * in `@inbrowser/model` that imports from it.
 */

import type {
  InferenceEvent,
  InferenceProvider,
  LegacyChatMessage,
  NormalizedRequest,
} from '@inbrowser/relay';
import type { Engine, EngineMessage } from '../types.js';

export function createLocalInferenceProvider(engine: Engine): InferenceProvider {
  return async function* (req: NormalizedRequest): AsyncIterable<InferenceEvent> {
    const messages = toEngineMessages(req.messages);
    const startedAt = performance.now();

    // Forward declared tools to the engine when the request brings
    // any. The engine itself gates emission on the preset's
    // capabilities.supportsTools — passing tools to a non-tools
    // preset is a no-op rather than an error so callers can be
    // backend-agnostic about which preset they bound to.
    const tools =
      req.tools.length > 0
        ? req.tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined;

    for await (const evt of engine.generate(messages, {
      temperature: req.temperature,
      topP: req.topP,
      topK: req.topK,
      ...(tools ? { tools } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    })) {
      if (evt.kind === 'token') {
        yield { kind: 'text', chunk: evt.text };
        continue;
      }
      if (evt.kind === 'thinking') {
        // InferenceEvent has its own 'thinking' kind — pass through.
        // The engine only emits this when the caller wrapped with
        // splitThinking() upstream.
        yield { kind: 'thinking', chunk: evt.text };
        continue;
      }
      if (evt.kind === 'tool_call') {
        yield {
          kind: 'tool_call',
          callId: evt.id,
          name: evt.name,
          args: evt.args,
        };
        continue;
      }
      if (evt.kind === 'usage') {
        yield {
          kind: 'usage',
          promptTokens: evt.promptTokens,
          outputTokens: evt.outputTokens,
        };
        continue;
      }
      yield { kind: 'error', message: evt.message };
      return;
    }

    void startedAt;
  };
}

function toEngineMessages(messages: ReadonlyArray<LegacyChatMessage>): EngineMessage[] {
  const out: EngineMessage[] = [];
  for (const m of messages) {
    // The engine vocabulary has no `tool` role — Gemma 4 is toolless.
    // Tool turns are flattened into the prior assistant message so the
    // model has the context, but the tool-call/result structure is
    // dropped. Tool support arrives via the polyfill in @inbrowser/agent.
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        text: `[tool ${m.name ?? ''} result]\n${m.resultJson ?? ''}`,
      });
      continue;
    }
    if (m.role === 'system' || m.role === 'user' || m.role === 'assistant') {
      out.push({ role: m.role, text: m.text ?? '' });
    }
  }
  return out;
}
