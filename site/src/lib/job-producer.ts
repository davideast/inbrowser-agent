/**
 * Job specs + the producer factory shared by the worker host and any caller
 * that needs to describe a job declaratively.
 *
 * A `Producer` is a function and can't cross `postMessage`, so the client ships
 * a serializable `JobSpec` and the worker reconstitutes the work via
 * `buildProducer(spec)` (see `hostJobEngine`'s `buildProducer` contract). The
 * agent spec (Phase 5) is the real payload: the worker rebuilds the CLOUD
 * `ModelClient` from the spec and drives the SAME `agentEvents` loop the inline
 * path runs, so a cloud chat is durable (its events persist + replay) with no UX
 * change. The demo spec stays as a model-free way to exercise the runtime.
 *
 * This module imports ONLY `@inbrowser/model`'s cloud provider factories +
 * `agentEvents` (which imports `@inbrowser/agent` + the client graph-tools, whose
 * embedder lazy-loads). It deliberately does NOT import the on-device engine /
 * `createOnDeviceModelClient` / transformers, so the worker bundle stays lean.
 */
import { createReactLoopStrategy } from '@inbrowser/agent';
import type { ContextWindowTraceHostContext } from '@inbrowser/agent/usage';
import type { ModelClient } from '@inbrowser/model';
import { geminiModelClient } from '@inbrowser/model/providers/gemini';
import { llamaServerModelClient } from '@inbrowser/model/providers/llama-server';
import { ollamaModelClient } from '@inbrowser/model/providers/ollama';
import { openrouterModelClient } from '@inbrowser/model/providers/openrouter';
import type { Producer } from '@inbrowser/resumable';
import { type DurableEvent, REACT_SYSTEM_PROMPT, agentEvents } from './local-agent';

/** A self-contained demo job: emit `count` tokens, `everyMs` apart. */
export interface DemoJobSpec {
  kind: 'demo';
  count: number;
  everyMs: number;
}

/** The CLOUD providers an agent job can run on. Mirrors the cloud branches of
 *  `buildLocalModelClient` (on-device WebGPU is never a durable job — it stays
 *  on the inline path). */
export type AgentProvider = 'gemini' | 'openrouter' | 'ollama' | 'llama';

/**
 * A durable agent run: everything the worker needs to rebuild the cloud
 * `ModelClient` and drive the agent loop, as plain serializable data.
 *  - `apiKey` — gemini / openrouter / (optional) llama bearer.
 *  - `baseUrl` — ollama / llama server URL.
 *  - `history` — prior turns (the question itself is NOT included here).
 */
export interface AgentJobSpec {
  kind: 'agent';
  provider: AgentProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  hostContext?: ContextWindowTraceHostContext;
  question: string;
  history: { role: 'user' | 'assistant'; text: string }[];
}

/** Union of every job the worker can run. */
export type JobSpec = DemoJobSpec | AgentJobSpec;

/**
 * Turn a serializable `JobSpec` into the `Producer<DurableEvent>` the engine
 * drives. The producer's `ctx.signal` fires when the engine wants the work
 * abandoned (job cancelled / stopped).
 *
 * For an agent job: rebuild the cloud `ModelClient` from the spec, then drive the
 * SAME `agentEvents` loop the inline path runs. The strategy choice mirrors
 * ChatApp's old inline branch exactly (so the durable path's behavior is
 * identical, just relocated into the worker):
 *  - llama-server advertises only `completion` → ALWAYS retrieval-only.
 *  - gemini / openrouter / ollama attempt the ReAct multi-tool loop; if a model
 *    rejects tools ("... does not support tools") BEFORE any output (an Ollama
 *    can serve arbitrary models), fall back to retrieval-only so it still
 *    answers. `agentEvents` returns on completion (engine → 'done') and throws on
 *    error (engine → 'error').
 */
export function buildProducer(spec: JobSpec): Producer<DurableEvent> {
  switch (spec.kind) {
    case 'demo':
      return async function* demo(ctx) {
        for (let i = 0; i < spec.count; i++) {
          if (ctx.signal.aborted) return;
          if (i > 0) await delay(spec.everyMs, ctx.signal);
          if (ctx.signal.aborted) return;
          yield { kind: 'token', text: `tok${i}` };
        }
      };
    case 'agent': {
      const client = buildAgentModelClient(spec);
      const wantsTools =
        spec.provider === 'gemini' || spec.provider === 'openrouter' || spec.provider === 'ollama';
      return async function* agent(ctx) {
        if (!wantsTools) {
          // llama: retrieval-only (the default strategy/prompt of `agentEvents`).
          yield* agentEvents(client, spec.question, spec.history, {
            signal: ctx.signal,
            hostContext: withStrategy(spec.hostContext, 'retrieval', 'provider-default'),
          });
          return;
        }
        // ReAct first; remember whether anything was produced so a tool-unsupported
        // error can fall back silently only when nothing has streamed yet.
        let produced = false;
        try {
          for await (const ev of agentEvents(client, spec.question, spec.history, {
            strategy: createReactLoopStrategy({ maxTurns: 10 }),
            systemPrompt: REACT_SYSTEM_PROMPT,
            signal: ctx.signal,
            hostContext: withStrategy(spec.hostContext, 'react', 'provider-default'),
          })) {
            produced = true;
            yield ev;
          }
          return;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (produced || !isToolUnsupportedError(message)) throw e;
        }
        // Fell through: tool-unsupported before any output → retrieval-only retry.
        yield* agentEvents(client, spec.question, spec.history, {
          signal: ctx.signal,
          hostContext: withStrategy(spec.hostContext, 'retrieval', 'fallback'),
        });
      };
    }
  }
}

function withStrategy(
  hostContext: ContextWindowTraceHostContext | undefined,
  strategy: string,
  strategySource: string,
): ContextWindowTraceHostContext | undefined {
  return hostContext ? { ...hostContext, strategy, strategySource } : undefined;
}

/** Ollama / llama-server (and some OpenAI-compatible servers) reject a tool-using
 *  request for models with no tool support, e.g. "... does not support tools".
 *  Detect that so the agent can fall back to the retrieval-only strategy. Mirrors
 *  the same check that lived inline in ChatApp. */
function isToolUnsupportedError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('tool') &&
    (m.includes('does not support') ||
      m.includes("doesn't support") ||
      m.includes('not support') ||
      m.includes('not supported') ||
      m.includes('unsupported'))
  );
}

/**
 * Build the CLOUD `ModelClient` for an agent job from its spec. This is the
 * worker-side twin of `model-source.ts`'s `buildLocalModelClient` cloud branches
 * (gemini / openrouter / ollama / llama), reconstructed from serializable spec
 * fields instead of the live config object — it must stay in step with that
 * builder. It imports ONLY the cloud provider factories, never the engine, so
 * the worker bundle never pulls the on-device transformers runtime.
 */
function buildAgentModelClient(spec: AgentJobSpec): ModelClient {
  switch (spec.provider) {
    case 'gemini':
      return geminiModelClient({ apiKey: spec.apiKey ?? '', model: spec.model, temperature: 0.2 });
    case 'openrouter':
      return openrouterModelClient({ apiKey: spec.apiKey ?? '', model: spec.model });
    case 'ollama':
      return ollamaModelClient({ baseUrl: spec.baseUrl ?? '', model: spec.model });
    case 'llama':
      return llamaServerModelClient({
        baseUrl: spec.baseUrl ?? '',
        model: spec.model,
        apiKey: spec.apiKey || undefined,
        temperature: 0.2,
      });
  }
}

/** A `setTimeout` delay that resolves early (without throwing) when aborted. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
