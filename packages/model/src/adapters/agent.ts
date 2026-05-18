/**
 * Adapt an on-device `Engine` to `@inbrowser/agent`'s `LlmClient`.
 * The agent runtime then drives a local model identically to a
 * cloud provider — same `chat(req, signal) → AsyncIterable<ChatEvent>`
 * surface.
 *
 * Tool calling: when `req.toolUseEnabled` is true and the engine
 * doesn't natively support tools, the adapter declines (yields a
 * single `error` event). The runtime can layer a tool-use polyfill
 * (`withToolUsePolyfill`) over this client to lift it into a
 * tool-capable one via prompt-engineered tool calling.
 *
 * `@inbrowser/agent` is a peer dep; this subpath is the only point
 * in `@inbrowser/model` that imports from it.
 */

import type {
  ChatEvent,
  ChatRequest,
  LlmClient,
  NormalizedMessage,
} from '@inbrowser/agent';
import type { Engine, EngineMessage } from '../types.js';

export function createLocalLlmClient(engine: Engine, id: string): LlmClient {
  return {
    id,
    supportsTools: engine.capabilities.supportsTools,
    chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      return drive(engine, req, signal);
    },
  };
}

async function* drive(
  engine: Engine,
  req: ChatRequest,
  signal: AbortSignal,
): AsyncIterable<ChatEvent> {
  if (req.toolUseEnabled && !engine.capabilities.supportsTools) {
    yield {
      kind: 'error',
      message:
        'engine does not natively support tools — wrap with withToolUsePolyfill before passing to the agent runtime',
    };
    return;
  }

  const messages = toEngineMessages(req.messages);
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const evt of engine.generate(messages, { signal })) {
    if (evt.kind === 'token') {
      yield { kind: 'text', chunk: evt.text };
      continue;
    }
    if (evt.kind === 'usage') {
      promptTokens = evt.promptTokens;
      completionTokens = evt.outputTokens;
      continue;
    }
    yield { kind: 'error', message: evt.message };
    return;
  }

  yield {
    kind: 'turn_complete',
    usage: { promptTokens, completionTokens },
    details: { requestedModel: engine.model.modelId },
  };
}

function toEngineMessages(messages: ReadonlyArray<NormalizedMessage>): EngineMessage[] {
  const out: EngineMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        text: `[tool ${m.name ?? ''} result]\n${m.resultJson ?? ''}`,
      });
      continue;
    }
    if (m.role === 'system' || m.role === 'user' || m.role === 'assistant') {
      out.push({ role: m.role, text: m.text });
    }
  }
  return out;
}
