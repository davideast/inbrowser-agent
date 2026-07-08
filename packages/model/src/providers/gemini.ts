import type {
  ModelClient,
  ModelErrorEvent,
  ModelEvent,
  ModelRequest,
  ReasoningEffort,
  ToolSpec,
} from '../contract.js';
import { readSseDataLines } from '../sse.js';
import type { CloudProviderConfig } from './types.js';
/**
 * Gemini provider — raw fetch against the Generative Language REST
 * API, parsing SSE directly. The `@google/genai` SDK is intentionally
 * NOT used here: dropping it lets the same code run unchanged
 * page-side and inside the relay (no SDK transport quirks), and lets
 * both built-in providers (Gemini + OpenRouter) be treated
 * symmetrically — both speak fetch + SSE.
 *
 * Endpoint: POST .../models/{model}:streamGenerateContent?alt=sse
 *
 * The chunk shape and thoughtSignature placement match what the SDK
 * produced. Streamed function calls are accumulated across chunks and
 * emitted exactly once (see `geminiEventsFromResponse`): Gemini
 * re-sends the growing `content.parts[]` list every chunk, so emitting
 * a `tool_call` per chunk would duplicate every call.
 */

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Per-request settings the provider reads off the `ModelRequest`. */
export interface GeminiConfig extends CloudProviderConfig {}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: unknown } };
}

interface GeminiBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string }[] };
  tools?: { functionDeclarations: unknown[] }[];
  generationConfig?: Record<string, unknown>;
}

const GEMINI_25_THINKING_BUDGET: Record<Exclude<ReasoningEffort, 'off'>, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
};

function buildGeminiThinkingConfig(
  model: string,
  effort: ReasoningEffort | undefined,
): Record<string, unknown> | undefined {
  if (!effort || effort === 'off') return undefined;

  const thinkingConfig: Record<string, unknown> = { includeThoughts: true };
  const normalized = model.toLowerCase();

  if (normalized.includes('gemini-3.5-') || normalized.includes('gemini-3-flash')) {
    thinkingConfig.thinkingLevel = effort;
  } else if (normalized.includes('gemini-2.5-')) {
    thinkingConfig.thinkingBudget = GEMINI_25_THINKING_BUDGET[effort];
  }

  return thinkingConfig;
}

function toGeminiBody(config: CloudProviderConfig, req: ModelRequest): GeminiBody {
  const contents: GeminiContent[] = [];
  let systemText = '';

  for (const m of req.messages) {
    if (m.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + (m.text ?? '');
      continue;
    }
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.text ?? '' }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls ?? []) {
        // Gemini 3: `thoughtSignature` is a sibling of `functionCall`
        // on the part, NOT a child. Echoing it on a different field
        // returns INVALID_ARGUMENT.
        const part: GeminiPart = {
          functionCall: {
            name: c.name,
            args: (c.args as Record<string, unknown>) ?? {},
          },
        };
        if (c.signature) part.thoughtSignature = c.signature;
        parts.push(part);
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }
    if (m.role === 'tool') {
      let parsed: unknown = null;
      try {
        if (m.resultJson) parsed = JSON.parse(m.resultJson);
      } catch {
        parsed = m.resultJson;
      }
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name ?? 'tool',
              response: { result: parsed },
            },
          },
        ],
      });
    }
  }

  const body: GeminiBody = { contents };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

  if (req.tools.length > 0) {
    const functionDeclarations = req.tools.map((t: ToolSpec) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: sanitizeGeminiSchema(t.function.parameters),
    }));
    body.tools = [{ functionDeclarations }];
  }

  const gen: Record<string, unknown> = {
    // Generous output budget. Left unset, the model can truncate a
    // large tool-call argument — writeApp/writeCode emit whole source
    // files as a string arg — and a truncated call is exactly what
    // Gemini then rejects as MALFORMED_FUNCTION_CALL. 65536 is the
    // Gemini 3 family max, so this never *reduces* a model's default;
    // a model that somehow doesn't support it fails loudly with a
    // 400, not silently.
    maxOutputTokens: 65536,
  };
  const thinkingConfig = buildGeminiThinkingConfig(config.model, req.reasoningEffort);
  if (thinkingConfig) gen.thinkingConfig = thinkingConfig;
  // Per-request temperature wins; otherwise fall back to the
  // construction-time default (the docs agent pins 0.2; the relay sets
  // neither, preserving "send only what the client did").
  const temperature = req.temperature ?? config.temperature;
  if (typeof temperature === 'number') gen.temperature = temperature;
  if (typeof req.topP === 'number') gen.topP = req.topP;
  if (typeof req.topK === 'number') gen.topK = req.topK;
  body.generationConfig = gen;

  return body;
}

interface GeminiStreamChunk {
  candidates?: {
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

/**
 * A function call being assembled across streaming chunks. Gemini's
 * `streamGenerateContent` re-sends the accumulating `content.parts[]`
 * every chunk, so one logical call surfaces many times — first
 * name-only with empty args, then with its full args, with its
 * `thoughtSignature` sometimes landing on a still-later chunk. We merge
 * those re-sends into one entry and emit a single `tool_call` at stream
 * end. Unlike the OpenAI/Anthropic providers — which receive `args` as
 * JSON-string fragments and *concatenate* — Gemini sends the complete
 * `args` object each time, so the merge *replaces* with the latest
 * non-empty snapshot.
 */
interface PendingGeminiCall {
  name: string;
  args: Record<string, unknown>;
  signature?: string;
}

/**
 * Build the upstream Gemini Request — URL + headers + body — without
 * executing it. The returned Request carries no AbortSignal; the
 * caller adds one at fetch time. Construction values (apiKey, model)
 * come from the provider config; per-call values (messages, tools,
 * sampling) from the `ModelRequest`.
 */
export function buildGeminiRequest(config: CloudProviderConfig, req: ModelRequest): Request {
  const url = `${ENDPOINT_BASE}/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`;
  return new Request(url, {
    method: 'POST',
    headers: {
      // Relay guarantees a resolved key before the provider runs
      // (BYOK 400s if missing; server-managed injects).
      'x-goog-api-key': config.apiKey ?? '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toGeminiBody(config, req)),
  });
}

/**
 * Format an error for a `{kind:'error'}` event — critically,
 * including `error.cause` when present. Node's `fetch` (undici)
 * reports network failures as a bare `TypeError: fetch failed` and
 * stows the real reason — `UND_ERR_HEADERS_TIMEOUT`,
 * `UND_ERR_BODY_TIMEOUT`, `ECONNRESET`, … — on `.cause`. Without
 * this, every server-side failure surfaces as an identical "fetch
 * failed" that tells us nothing.
 */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as Error & { cause?: unknown }).cause;
  if (cause == null) return e.message;
  let causeStr: string;
  if (cause instanceof Error) {
    causeStr = cause.message ? `${cause.name}: ${cause.message}` : cause.name;
  } else if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    causeStr = String((cause as { code: unknown }).code);
  } else {
    causeStr = String(cause);
  }
  return `${e.message} (${causeStr})`;
}

/**
 * Parse an already-fetched Gemini SSE response into `ModelEvent`s.
 * `signal` is optional — the relay passes the consumer's signal in,
 * the page-direct caller passes its own.
 *
 * Function calls are accumulated across chunks (Gemini re-sends the
 * growing parts list) and flushed as one `tool_call` per logical call
 * at stream end, so a turn with N calls yields exactly N events with
 * complete args and signatures.
 */
export async function* geminiEventsFromResponse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<ModelEvent> {
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    yield { kind: 'error', message: `Gemini ${response.status}: ${text.slice(0, 240)}` };
    return;
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;
  // Diagnostics for the "thinking-only, no output" case: Gemini can
  // end a response after the thinking phase having produced nothing
  // visible. `finishReason` on the last chunk names why (MAX_TOKENS /
  // SAFETY / RECITATION); a missing one means the stream was simply
  // truncated. `sawOutput` tracks whether any *visible* output (text
  // or a tool call — not thinking) actually came through.
  let sawThinking = false;
  let sawVisibleText = false;
  let sawFunctionCall = false;
  let lastFinishReason: string | undefined;
  // Function calls accumulate here and are flushed once, after the
  // stream closes (see the per-part merge below and the flush loop).
  // Keyed by the call's ordinal position among the turn's function
  // calls — the one correlation key Gemini's stream offers (parts carry
  // no id or index).
  const pending = new Map<number, PendingGeminiCall>();

  try {
    for await (const payload of readSseDataLines(response.body)) {
      if (signal?.aborted) return;
      let chunk: GeminiStreamChunk;
      try {
        chunk = JSON.parse(payload) as GeminiStreamChunk;
      } catch {
        continue;
      }
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      // Position of a functionCall part *among the functionCall parts in
      // this chunk* — NOT its raw index in `parts[]`. Gemini re-sends the
      // whole accumulating parts list each chunk, but the leading text
      // deltas drop out of later chunks, so a call's raw array index
      // shifts between chunks while its ordinal among function calls
      // stays put. That ordinal is the stable correlation key.
      //
      // Invariant this relies on: across re-sends Gemini only ever
      // appends function-call parts, never dropping or reordering an
      // earlier one, so the k-th call keeps ordinal k. That holds for the
      // relay's custom-function tools — it advertises no built-in Google
      // tools whose parts could interleave and shift the ordinals.
      let fnOrdinal = 0;
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text.length > 0) {
          if (p.thought === true) {
            sawThinking = true;
            yield { kind: 'thinking', text: p.text };
          } else {
            sawVisibleText = true;
            yield { kind: 'text', text: p.text };
          }
        }
        if (p.functionCall) {
          sawFunctionCall = true;
          const slot = fnOrdinal++;
          let call = pending.get(slot);
          if (!call) {
            call = { name: '', args: {} };
            pending.set(slot, call);
          }
          // Merge re-sends into the slot. Name and args fill in over
          // successive chunks; Gemini sends the complete args object each
          // time, so the latest non-empty snapshot is the full one
          // (replace, don't concatenate). An all-empty re-send never
          // clobbers args already captured.
          //
          // This reads the default `functionCall.args` shape. Gemini 3's
          // opt-in argument-streaming mode instead emits `partialArgs`
          // fragments with `willContinue` — the relay never requests that
          // mode (`toGeminiBody` sends no `functionCallingConfig`), so
          // args always arrive whole. If that ever changes, reconstruct
          // from `partialArgs` here; until then such args would stay `{}`.
          if (p.functionCall.name) call.name = p.functionCall.name;
          const incomingArgs = p.functionCall.args;
          if (
            incomingArgs &&
            typeof incomingArgs === 'object' &&
            !Array.isArray(incomingArgs) &&
            Object.keys(incomingArgs).length > 0
          ) {
            call.args = incomingArgs;
          }
          // thoughtSignature is a sibling of functionCall on the part and
          // frequently arrives on a later chunk than the args. Capturing
          // it per-slot is what keeps the signature attached to its call
          // for Gemini-3 replay.
          if (p.thoughtSignature) call.signature = p.thoughtSignature;
        }
      }
      const finishReason = chunk.candidates?.[0]?.finishReason;
      if (finishReason) lastFinishReason = finishReason;
      const usage = chunk.usageMetadata;
      if (usage) {
        promptTokens = usage.promptTokenCount ?? promptTokens;
        completionTokens = usage.candidatesTokenCount ?? completionTokens;
        if (typeof usage.cachedContentTokenCount === 'number') {
          cachedTokens = usage.cachedContentTokenCount;
        }
        if (typeof usage.thoughtsTokenCount === 'number') {
          reasoningTokens = usage.thoughtsTokenCount;
        }
      }
    }
  } catch (e) {
    if (signal?.aborted) return;
    yield { kind: 'error', message: describeError(e) };
    return;
  }

  // Stream ended cleanly but the model never produced visible output —
  // only thinking. Surface why: a non-STOP `finishReason` names it,
  // `none` means the stream was truncated before one arrived.
  if (!sawVisibleText && !sawFunctionCall) {
    yield geminiNoOutputError({
      finishReason: lastFinishReason,
      sawThinking,
      sawVisibleText,
      sawFunctionCall,
    });
    return;
  }

  // Flush the accumulated function calls — exactly one `tool_call` per
  // logical call, carrying its complete args and thoughtSignature. The
  // `id` is the call's stable ordinal (not a per-chunk random value), so
  // re-parsing the same stream is deterministic and the id is identical
  // across the args/signature that arrived on different chunks.
  for (const [slot, call] of pending) {
    // Skip a slot that never got a name — a stray empty partial, never
    // dispatchable — so a turn with N real calls still yields exactly N
    // events. A named call with empty args is legitimate (a no-arg tool)
    // and is kept.
    if (!call.name) continue;
    yield {
      kind: 'tool_call',
      id: `gem_${slot}`,
      name: call.name,
      args: call.args,
      ...(call.signature ? { signature: call.signature } : {}),
    };
  }

  yield {
    kind: 'usage',
    usage: {
      promptTokens,
      outputTokens: completionTokens,
      ...(cachedTokens > 0 ? { cachedTokens } : {}),
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    },
  };
}

function geminiNoOutputError(opts: {
  finishReason: string | undefined;
  sawThinking: boolean;
  sawVisibleText: boolean;
  sawFunctionCall: boolean;
}): ModelErrorEvent {
  const finishReason = opts.finishReason ?? 'none';
  const message = `Gemini produced no output — finishReason=${finishReason} (${
    opts.sawThinking
      ? 'response ended after thinking only'
      : 'response ended with no visible output'
  })`;

  let code = 'gemini.no_output';
  let retryable = false;
  if (opts.finishReason === undefined) {
    code = 'gemini.truncated_no_output';
    retryable = true;
  } else if (opts.finishReason === 'MALFORMED_FUNCTION_CALL') {
    code = 'gemini.malformed_function_call';
    retryable = true;
  } else if (opts.finishReason === 'STOP' && opts.sawThinking) {
    code = 'gemini.thinking_only_stop';
    retryable = true;
  }

  return {
    kind: 'error',
    message,
    code,
    retryable,
    details: {
      finishReason,
      sawThinking: opts.sawThinking,
      sawVisibleText: opts.sawVisibleText,
      sawFunctionCall: opts.sawFunctionCall,
    },
  };
}

/**
 * Total Gemini attempts per call. Three classes of failure benefit
 * from retry — all transient, all leave the turn with no usable
 * output, and the same prompt frequently succeeds on the next attempt:
 *
 *   - `MALFORMED_FUNCTION_CALL` — Gemini 3 intermittently emits a
 *     function call its own API then rejects.
 *   - `finishReason=STOP` with no visible output — the model decided
 *     to think and then said nothing. Common in long-context turns.
 *   - `finishReason=none` — the stream was truncated before a
 *     finishReason arrived; usually a transient transport blip.
 *
 * Deterministic failures (`finishReason=SAFETY` / `RECITATION` /
 * `MAX_TOKENS`) are NOT retried — those are determined by the input
 * and a retry only burns API calls.
 *
 * The retried attempt is a *fresh* generation — its thinking is
 * streamed too, so a recovered turn shows the prior (discarded)
 * thinking ahead of the real answer. A cosmetic cost on what was
 * otherwise a hard failure.
 */
const MAX_GEMINI_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

/** Substrings kept as a fallback for older message-only provider errors. */
const RETRYABLE_ERROR_MARKERS = [
  'MALFORMED_FUNCTION_CALL',
  'finishReason=STOP',
  'finishReason=none',
];

function isRetryableError(event: ModelErrorEvent): boolean {
  if (event.retryable === true) return true;
  if (event.retryable === false) return false;
  return RETRYABLE_ERROR_MARKERS.some((m) => event.message.includes(m));
}

function withAttemptMetadata(
  event: ModelErrorEvent,
  attempt: number,
  maxAttempts: number,
): ModelErrorEvent {
  return {
    ...event,
    details: {
      ...(event.details ?? {}),
      attempt,
      maxAttempts,
    },
  };
}

/**
 * Build a Gemini `ModelClient`. Construction values (apiKey, model)
 * come in the config; per-call values (messages, tools, sampling) come
 * in the `ModelRequest`.
 */
export function geminiModelClient(config: GeminiConfig): ModelClient {
  return {
    id: `gemini:${config.model}`,
    supportsTools: true,
    async *chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      for (let attempt = 1; attempt <= MAX_GEMINI_ATTEMPTS; attempt++) {
        if (signal?.aborted) return;
        const request = buildGeminiRequest(config, req);

        let response: Response;
        try {
          response = await fetch(request, signal ? { signal } : {});
        } catch (e) {
          if (signal?.aborted) return;
          yield { kind: 'error', message: describeError(e) };
          return;
        }

        let retry = false;
        for await (const evt of geminiEventsFromResponse(response, signal)) {
          // Swallow retryable errors so the next attempt can recover.
          // The non-retryable kinds (SAFETY, RECITATION, MAX_TOKENS,
          // network/parse failures) fall straight through and surface.
          // Final attempt always yields whatever it produces.
          if (evt.kind === 'error' && isRetryableError(evt) && attempt < MAX_GEMINI_ATTEMPTS) {
            retry = true;
            break;
          }
          yield evt.kind === 'error' ? withAttemptMetadata(evt, attempt, MAX_GEMINI_ATTEMPTS) : evt;
        }

        if (!retry) return;
        try {
          await response.body?.cancel();
        } catch {
          /* already released — fine */
        }
        if (signal?.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    },
  };
}

/**
 * Strip JSON-Schema keywords Gemini's `function_declarations[].parameters`
 * validator rejects. The validator is a narrow subset of OpenAPI 3.0
 * Schema — anything `zodToJsonSchema` (or hand-written JSON Schema)
 * emits beyond that subset 400s with `Unknown name "<key>"`.
 *
 * Keys stripped:
 *   - `additionalProperties` — emitted by `zodToJsonSchema` on every
 *     object; Gemini rejects it outright.
 *   - `$schema`, `$ref`, `$defs`, `definitions` — JSON-Schema-isms not
 *     supported in OpenAPI 3.0 Schema.
 *
 * OpenRouter's adapter accepts the standard JSON Schema unchanged —
 * no equivalent sanitizer there.
 *
 * Implementation: deep-clone walk so we never mutate the caller's
 * schema object (the same `parameters` reference is held by the
 * ToolRegistry and shared across providers).
 */
const STRIP_KEYS = new Set(['additionalProperties', '$schema', '$ref', '$defs', 'definitions']);

export function sanitizeGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeGeminiSchema);
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (STRIP_KEYS.has(k)) continue;
      out[k] = sanitizeGeminiSchema(v);
    }
    return out;
  }
  return node;
}
