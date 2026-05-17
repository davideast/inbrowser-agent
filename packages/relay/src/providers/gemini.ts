import { readSseDataLines } from '../sse';
import type { InferenceEvent, InferenceProvider, NormalizedRequest } from '../types';
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
 * The chunk shape, thoughtSignature placement, and tool-call callId
 * generation match what the SDK produced.
 */
import type { LegacyChatMessage, LegacyToolDecl } from '../types.js';

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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

function toGeminiBody(req: NormalizedRequest): GeminiBody {
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
    const functionDeclarations = req.tools.map((t: LegacyToolDecl) => ({
      name: t.name,
      description: t.description,
      parameters: sanitizeGeminiSchema(t.parameters),
    }));
    body.tools = [{ functionDeclarations }];
  }

  const gen: Record<string, unknown> = {
    thinkingConfig: { includeThoughts: true },
    // Generous output budget. Left unset, the model can truncate a
    // large tool-call argument — writeApp/writeCode emit whole source
    // files as a string arg — and a truncated call is exactly what
    // Gemini then rejects as MALFORMED_FUNCTION_CALL. 65536 is the
    // Gemini 3 family max, so this never *reduces* a model's default;
    // a model that somehow doesn't support it fails loudly with a
    // 400, not silently.
    maxOutputTokens: 65536,
  };
  if (typeof req.temperature === 'number') gen.temperature = req.temperature;
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
  };
}

/**
 * Build the upstream Gemini Request — URL + headers + body — without
 * executing it. The returned Request carries no AbortSignal; the
 * caller adds one at fetch time.
 */
export function buildGeminiRequest(req: NormalizedRequest): Request {
  const url = `${ENDPOINT_BASE}/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
  return new Request(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': req.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toGeminiBody(req)),
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
 * Parse an already-fetched Gemini SSE response into `InferenceEvent`s.
 * `signal` is optional — the relay passes the consumer's signal in,
 * the page-direct caller passes `req.signal`.
 */
export async function* geminiEventsFromResponse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<InferenceEvent> {
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    yield { kind: 'error', message: `Gemini ${response.status}: ${text.slice(0, 240)}` };
    return;
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  // Diagnostics for the "thinking-only, no output" case: Gemini can
  // end a response after the thinking phase having produced nothing
  // visible. `finishReason` on the last chunk names why (MAX_TOKENS /
  // SAFETY / RECITATION); a missing one means the stream was simply
  // truncated. `sawOutput` tracks whether any *visible* output (text
  // or a tool call — not thinking) actually came through.
  let sawOutput = false;
  let lastFinishReason: string | undefined;

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
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text.length > 0) {
          if (p.thought === true) {
            yield { kind: 'thinking', chunk: p.text };
          } else {
            sawOutput = true;
            yield { kind: 'text', chunk: p.text };
          }
        }
        if (p.functionCall) {
          sawOutput = true;
          yield {
            kind: 'tool_call',
            callId: `gem_${Math.random().toString(36).slice(2, 10)}`,
            name: p.functionCall.name ?? '',
            args: (p.functionCall.args as Record<string, unknown>) ?? {},
            ...(p.thoughtSignature ? { signature: p.thoughtSignature } : {}),
          };
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
  if (!sawOutput) {
    yield {
      kind: 'error',
      message: `Gemini produced no output — finishReason=${
        lastFinishReason ?? 'none'
      } (response ended after thinking only)`,
    };
    return;
  }

  yield {
    kind: 'usage',
    promptTokens,
    outputTokens: completionTokens,
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
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

/** Substrings that identify a retryable provider error. Matched
 *  against `InferenceEvent.message` from `geminiEventsFromResponse`. */
const RETRYABLE_ERROR_MARKERS = [
  'MALFORMED_FUNCTION_CALL',
  'finishReason=STOP',
  'finishReason=none',
];

function isRetryableError(message: string): boolean {
  return RETRYABLE_ERROR_MARKERS.some((m) => message.includes(m));
}

export const geminiProvider: InferenceProvider = async function* (req) {
  for (let attempt = 1; attempt <= MAX_GEMINI_ATTEMPTS; attempt++) {
    if (req.signal?.aborted) return;
    const request = buildGeminiRequest(req);

    let response: Response;
    try {
      response = await fetch(request, req.signal ? { signal: req.signal } : {});
    } catch (e) {
      if (req.signal?.aborted) return;
      yield { kind: 'error', message: describeError(e) };
      return;
    }

    let retry = false;
    for await (const evt of geminiEventsFromResponse(response, req.signal)) {
      // Swallow retryable errors so the next attempt can recover.
      // The non-retryable kinds (SAFETY, RECITATION, MAX_TOKENS,
      // network/parse failures) fall straight through and surface.
      // Final attempt always yields whatever it produces.
      if (evt.kind === 'error' && isRetryableError(evt.message) && attempt < MAX_GEMINI_ATTEMPTS) {
        retry = true;
        break;
      }
      yield evt;
    }

    if (!retry) return;
    try {
      await response.body?.cancel();
    } catch {
      /* already released — fine */
    }
    if (req.signal?.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
};

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

function sanitizeGeminiSchema(node: unknown): unknown {
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
