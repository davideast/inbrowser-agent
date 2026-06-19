/**
 * `createEngineModelClient` — wraps an on-device `Engine` as a `ModelClient`.
 *
 * This is the adapter that lets the on-device engine plug into the same
 * `ModelClient` contract the cloud providers (and the relay + agent) speak.
 * Without it the engine can only be driven directly via its `EngineEvent`
 * stream; with it the engine is just another `ModelClient` the agent/relay
 * can route to.
 *
 * The mapping is deliberately lossless in the directions that matter and
 * drops the cloud-irrelevant engine extras:
 *
 *   - `EngineEvent.token`     → `{ kind: 'text', text }`
 *   - `EngineEvent.thinking`  → `{ kind: 'thinking', text }`
 *   - `EngineEvent.tool_call` → `{ kind: 'tool_call', id, name, args }`
 *                               (the engine emits no signature — omitted)
 *   - `EngineEvent.usage`     → `{ kind: 'usage', usage: { promptTokens,
 *                               outputTokens } }` (`decodeMs` is dropped)
 *   - `EngineEvent.error`     → `{ kind: 'error', message }`
 *                               (`recoverable` is dropped)
 *
 * The engine already emits exactly one terminal `usage` (success) or `error`
 * (failure) before its stream returns, so the contract's "exactly one of
 * {usage, error} per turn" invariant carries straight through — this adapter
 * synthesizes nothing.
 *
 * This module has runtime imports (it constructs a `ModelClient` at runtime
 * and imports engine types), so it lives on the engine surface, NOT in the
 * type-only `./contract` module.
 */

import type { ModelClient, ModelEvent, ModelMessage, ModelRequest } from './contract.js';
import type { Engine, EngineMessage } from './types.js';

/**
 * Wrap an `Engine` as a `ModelClient`.
 *
 * @param engine The on-device engine to drive.
 * @param id Stable id for metrics + provenance. Defaults to
 *   `local:${engine.model.modelId}` when the engine exposes a model id,
 *   else `'local'`. The engine has no preset id of its own — `engine.model`
 *   is a bare `ModelRef` (HF Hub `modelId`), which is the most stable handle
 *   available.
 */
export function createEngineModelClient(engine: Engine, id?: string): ModelClient {
  const resolvedId = id ?? (engine.model?.modelId ? `local:${engine.model.modelId}` : 'local');

  return {
    id: resolvedId,
    supportsTools: engine.capabilities.supportsTools,
    chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      const engineMessages = toEngineMessages(req.messages);
      const stream = engine.generate(engineMessages, {
        tools: req.toolUseEnabled ? req.tools : undefined,
        temperature: req.temperature,
        topP: req.topP,
        topK: req.topK,
        signal,
      });
      return mapEvents(stream);
    },
  };
}

/**
 * Flatten the contract's `ModelMessage[]` into the engine's toolless
 * `EngineMessage[]`. `EngineMessage` has no tool round-trip fields (role is
 * `system | user | assistant`, plus `text`), so two shapes the engine can't
 * represent are flattened into plain text it can still read for grounding:
 *
 *   - A `role: 'tool'` result becomes a `user` line:
 *     `Tool ${name} result: ${resultJson}`.
 *   - An `assistant` turn carrying `toolCalls` keeps its text (if any) and
 *     appends a `Tool call: ${name}(${args})` line per call, so the call the
 *     assistant made survives into the prompt rather than being silently lost.
 *
 * For the retrieval strategy these are just system/user messages and pass
 * straight through; the flattening exists so the general case is lossless.
 */
function toEngineMessages(messages: ReadonlyArray<ModelMessage>): EngineMessage[] {
  const out: EngineMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const name = m.name ?? 'tool';
      const body = m.resultJson ?? m.text ?? '';
      out.push({ role: 'user', text: `Tool ${name} result: ${body}` });
      continue;
    }

    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const lines: string[] = [];
      if (m.text) lines.push(m.text);
      for (const call of m.toolCalls) {
        lines.push(`Tool call: ${call.name}(${stringifyArgs(call.args)})`);
      }
      out.push({ role: 'assistant', text: lines.join('\n') });
      continue;
    }

    // system / user / plain assistant → role + text straight through.
    out.push({ role: m.role, text: m.text ?? '' });
  }
  return out;
}

function stringifyArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return String(args);
  }
}

/** Translate the engine's `EngineEvent` stream into `ModelEvent`s. */
async function* mapEvents(
  source: AsyncIterable<import('./types.js').EngineEvent>,
): AsyncIterable<ModelEvent> {
  for await (const ev of source) {
    switch (ev.kind) {
      case 'token':
        yield { kind: 'text', text: ev.text };
        break;
      case 'thinking':
        yield { kind: 'thinking', text: ev.text };
        break;
      case 'tool_call':
        // The engine emits no signature; omit it.
        yield { kind: 'tool_call', id: ev.id, name: ev.name, args: ev.args };
        break;
      case 'usage':
        // Drop `decodeMs` — not part of the cloud `ModelUsage` shape.
        yield {
          kind: 'usage',
          usage: { promptTokens: ev.promptTokens, outputTokens: ev.outputTokens },
        };
        break;
      case 'error':
        // Drop `recoverable` — the contract's error event is terminal + flat.
        yield { kind: 'error', message: ev.message };
        break;
    }
  }
}
