import type {
  ModelClient,
  ModelErrorEvent,
  ModelEvent,
  ModelRequest,
  ModelUsage,
} from '../contract.js';
import {
  UnsupportedGeminiSchemaError,
  geminiNoOutputError,
  parseJsonValue,
  selectGeminiThinking,
  toGeminiFunctionDeclarations,
} from './gemini-protocol.js';

/** The per-call option subset used from Firebase AI Logic. */
export interface FirebaseAiLogicRequestOptionsLike {
  signal?: AbortSignal;
}

/**
 * Narrow structural port implemented by Firebase AI Logic's `GenerativeModel`.
 *
 * Keeping this structural avoids a runtime or type dependency on `firebase`:
 * callers construct the model with their own Firebase app/backend/App Check
 * configuration, then hand that model to this adapter.
 */
export interface FirebaseAiLogicGenerativeModelLike {
  readonly model: string;
  generateContentStream(
    request: unknown,
    options?: FirebaseAiLogicRequestOptionsLike,
  ): Promise<{
    stream: AsyncIterable<unknown>;
    /** Retains prompt feedback that Firebase omits from its public stream. */
    response: Promise<unknown>;
  }>;
}

export interface FirebaseAiLogicModelClientOptions {
  /** Stable metrics/provenance id. Defaults to `firebase-ai-logic:${model.model}`. */
  id?: string;
  /** Construction-time sampling default; a per-request temperature wins. */
  temperature?: number;
}

interface FirebaseAiLogicPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
}

interface PendingFunctionCall {
  upstreamId?: string;
  syntheticIndex: number;
  name: string;
  args: Record<string, unknown>;
  signature?: string;
}

interface FirebaseAiLogicResponse {
  candidates?: Array<{
    content?: {
      parts?: FirebaseAiLogicPart[];
    };
    finishReason?: string;
    finishMessage?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
}

interface FirebaseAiLogicRequest {
  contents: Array<{
    role: 'user' | 'model' | 'function';
    parts: FirebaseAiLogicPart[];
  }>;
  systemInstruction?: string;
  tools: unknown[];
  generationConfig: Record<string, unknown>;
}

// These are the finish reasons for which Firebase's own response helpers
// reject `text()` / `functionCalls()` instead of treating the candidate as a
// successful partial response. MAX_TOKENS and OTHER deliberately remain usable.
const BAD_FIREBASE_FINISH_REASONS = new Set([
  'RECITATION',
  'SAFETY',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'MALFORMED_FUNCTION_CALL',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_OTHER',
  'NO_IMAGE',
  'IMAGE_RECITATION',
  'LANGUAGE',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
  'MISSING_THOUGHT_SIGNATURE',
  'MALFORMED_RESPONSE',
]);

/** Wrap a caller-constructed Firebase AI Logic model as a `ModelClient`. */
export function createFirebaseAiLogicModelClient(
  model: FirebaseAiLogicGenerativeModelLike,
  options: FirebaseAiLogicModelClientOptions = {},
): ModelClient {
  return {
    id: options.id ?? `firebase-ai-logic:${model.model}`,
    supportsTools: true,
    async *chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      if (signal.aborted) return;
      try {
        const result = await model.generateContentStream(
          toFirebaseRequest(model.model, req, options),
          { signal },
        );
        const aggregateResult = result.response.then(
          (response) => ({ response }),
          (error: unknown) => ({ error }),
        );
        if (signal.aborted) return;
        let usage: ModelUsage = { promptTokens: 0, outputTokens: 0 };
        const pendingCalls: PendingFunctionCall[] = [];
        const callsByUpstreamId = new Map<string, PendingFunctionCall>();
        let sawThinking = false;
        let sawVisibleText = false;
        let sawFunctionCall = false;
        let lastFinishReason: string | undefined;
        let lastFinishMessage: string | undefined;
        let promptFeedback: FirebaseAiLogicResponse['promptFeedback'];

        for await (const rawChunk of result.stream) {
          if (signal.aborted) return;
          const chunk = rawChunk as FirebaseAiLogicResponse;
          for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
            if (typeof part.text === 'string' && part.text.length > 0) {
              if (part.thought) sawThinking = true;
              else sawVisibleText = true;
              yield part.thought
                ? { kind: 'thinking', text: part.text }
                : { kind: 'text', text: part.text };
            }
            if (part.functionCall) {
              const upstreamId = part.functionCall.id;
              let pending = upstreamId ? callsByUpstreamId.get(upstreamId) : undefined;
              if (!pending) {
                pending = {
                  ...(upstreamId ? { upstreamId } : {}),
                  syntheticIndex: pendingCalls.length,
                  name: '',
                  args: {},
                };
                pendingCalls.push(pending);
                if (upstreamId) callsByUpstreamId.set(upstreamId, pending);
              }
              if (part.functionCall.name) {
                sawFunctionCall = true;
                pending.name = part.functionCall.name;
              }
              const args = part.functionCall.args;
              if (
                args &&
                (Object.keys(args).length > 0 || Object.keys(pending.args).length === 0)
              ) {
                pending.args = args;
              }
              if (part.thoughtSignature) pending.signature = part.thoughtSignature;
            }
          }

          const finishReason = chunk.candidates?.[0]?.finishReason;
          if (finishReason) {
            lastFinishReason = finishReason;
            lastFinishMessage = chunk.candidates?.[0]?.finishMessage;
          }
          if (chunk.promptFeedback?.blockReason) promptFeedback = chunk.promptFeedback;

          if (chunk.usageMetadata) {
            usage = updateUsage(usage, chunk.usageMetadata);
          }
        }
        if (signal.aborted) return;

        const aggregate = await aggregateResult;
        if ('error' in aggregate) throw aggregate.error;
        const aggregateResponse = aggregate.response as FirebaseAiLogicResponse;
        promptFeedback = aggregateResponse.promptFeedback ?? promptFeedback;
        const aggregateCandidate = aggregateResponse.candidates?.[0];
        if (aggregateCandidate?.finishReason) {
          lastFinishReason = aggregateCandidate.finishReason;
          lastFinishMessage = aggregateCandidate.finishMessage;
        }
        if (aggregateResponse.usageMetadata) {
          usage = updateUsage(usage, aggregateResponse.usageMetadata);
        }
        if (signal.aborted) return;

        if (promptFeedback?.blockReason) {
          yield firebasePromptBlockedError(promptFeedback);
          return;
        }

        if (
          lastFinishReason !== 'MALFORMED_FUNCTION_CALL' &&
          isBadFirebaseFinishReason(lastFinishReason)
        ) {
          yield firebaseCandidateBlockedError(lastFinishReason, lastFinishMessage);
          return;
        }

        if (!sawVisibleText && !sawFunctionCall) {
          yield geminiNoOutputError('Firebase AI Logic', 'firebase-ai-logic', {
            finishReason: lastFinishReason,
            sawThinking,
            sawVisibleText,
            sawFunctionCall,
          });
          return;
        }

        if (isBadFirebaseFinishReason(lastFinishReason)) {
          yield firebaseCandidateBlockedError(lastFinishReason, lastFinishMessage);
          return;
        }

        for (const call of pendingCalls) {
          if (!call.name) continue;
          yield {
            kind: 'tool_call',
            id: call.upstreamId ?? `firebase_${call.syntheticIndex}`,
            name: call.name,
            args: call.args,
            ...(call.signature ? { signature: call.signature } : {}),
          };
        }

        yield { kind: 'usage', usage };
      } catch (error) {
        if (signal.aborted) return;
        yield normalizeFirebaseError(error);
      }
    },
  };
}

function isBadFirebaseFinishReason(reason: string | undefined): reason is string {
  return reason !== undefined && BAD_FIREBASE_FINISH_REASONS.has(reason);
}

function firebaseCandidateBlockedError(
  finishReason: string,
  finishMessage: string | undefined,
): ModelErrorEvent {
  const malformedFunctionCall = finishReason === 'MALFORMED_FUNCTION_CALL';
  return {
    kind: 'error',
    message: `Firebase AI Logic candidate ${
      malformedFunctionCall ? 'ended with' : 'was blocked due to'
    } ${finishReason}${finishMessage ? `: ${finishMessage}` : ''}`,
    code: malformedFunctionCall
      ? 'firebase-ai-logic.malformed_function_call'
      : 'firebase-ai-logic.candidate_blocked',
    retryable: malformedFunctionCall,
    details: {
      finishReason,
      ...(finishMessage ? { finishMessage } : {}),
    },
  };
}

function firebasePromptBlockedError(
  feedback: NonNullable<FirebaseAiLogicResponse['promptFeedback']>,
): ModelErrorEvent {
  const reason = feedback.blockReason ?? 'unknown';
  const message = feedback.blockReasonMessage
    ? `Firebase AI Logic blocked the prompt: ${feedback.blockReasonMessage}`
    : `Firebase AI Logic blocked the prompt (${reason})`;
  return {
    kind: 'error',
    message,
    code: 'firebase-ai-logic.prompt_blocked',
    retryable: false,
    details: { blockReason: reason },
  };
}

function updateUsage(
  usage: ModelUsage,
  next: NonNullable<FirebaseAiLogicResponse['usageMetadata']>,
): ModelUsage {
  const cachedTokens = next.cachedContentTokenCount ?? usage.cachedTokens;
  const reasoningTokens = next.thoughtsTokenCount ?? usage.reasoningTokens;
  return {
    promptTokens: next.promptTokenCount ?? usage.promptTokens,
    outputTokens: next.candidatesTokenCount ?? usage.outputTokens,
    ...(typeof cachedTokens === 'number' ? { cachedTokens } : {}),
    ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
  };
}

function normalizeFirebaseError(error: unknown): ModelErrorEvent {
  if (error instanceof UnsupportedGeminiSchemaError) {
    return {
      kind: 'error',
      message: error.message,
      code: 'firebase-ai-logic.invalid-tool-schema',
      retryable: false,
      details: { keyword: error.keyword, path: error.path },
    };
  }
  const source = error as {
    code?: unknown;
    message?: unknown;
    customErrorData?: {
      status?: unknown;
      statusText?: unknown;
      errorDetails?: unknown;
    };
  };
  const rawCode = typeof source?.code === 'string' ? source.code : undefined;
  const codeSuffix = rawCode?.split('/').at(-1);
  const status =
    typeof source?.customErrorData?.status === 'number' ? source.customErrorData.status : undefined;
  const details: Record<string, unknown> = {};
  if (status !== undefined) details.status = status;
  if (typeof source?.customErrorData?.statusText === 'string') {
    details.statusText = source.customErrorData.statusText;
  }
  if (source?.customErrorData?.errorDetails !== undefined) {
    details.errorDetails = source.customErrorData.errorDetails;
  }
  const retryable =
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    codeSuffix === 'fetch-error' ||
    codeSuffix === 'parse-failed';
  let message = String(error);
  if (error instanceof Error) message = error.message;
  if (typeof source?.message === 'string') message = source.message;

  return {
    kind: 'error',
    message,
    ...(codeSuffix ? { code: `firebase-ai-logic.${codeSuffix}` } : {}),
    retryable,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

function toFirebaseRequest(
  model: string,
  req: ModelRequest,
  options: FirebaseAiLogicModelClientOptions,
): FirebaseAiLogicRequest {
  let systemInstruction = '';
  const contents: FirebaseAiLogicRequest['contents'] = [];

  for (let index = 0; index < req.messages.length; index++) {
    const message = req.messages[index];
    if (!message) continue;
    if (message.role === 'system') {
      systemInstruction += `${systemInstruction ? '\n\n' : ''}${message.text ?? ''}`;
    } else if (message.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: message.text ?? '' }] });
    } else if (message.role === 'assistant') {
      const parts: FirebaseAiLogicPart[] = [];
      if (message.text) parts.push({ text: message.text });
      for (const call of message.toolCalls ?? []) {
        parts.push({
          functionCall: {
            ...(!isSyntheticId(call.id) ? { id: call.id } : {}),
            name: call.name,
            args: toArgsObject(call.args),
          },
          ...(call.signature ? { thoughtSignature: call.signature } : {}),
        });
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
    } else if (message.role === 'tool') {
      const parts: FirebaseAiLogicPart[] = [];
      let toolMessage = message;
      while (toolMessage?.role === 'tool') {
        parts.push({
          functionResponse: {
            ...(!isSyntheticId(toolMessage.toolCallId) && toolMessage.toolCallId
              ? { id: toolMessage.toolCallId }
              : {}),
            name: toolMessage.name ?? 'tool',
            response: parseFunctionResponse(toolMessage.resultJson),
          },
        });
        index += 1;
        toolMessage = req.messages[index]!;
      }
      index -= 1;
      contents.push({ role: 'function', parts });
    }
  }

  const generationConfig: Record<string, unknown> = { maxOutputTokens: 65_536 };
  const temperature = req.temperature ?? options.temperature;
  if (typeof temperature === 'number') generationConfig.temperature = temperature;
  if (typeof req.topP === 'number') generationConfig.topP = req.topP;
  if (typeof req.topK === 'number') generationConfig.topK = req.topK;
  const thinking = selectGeminiThinking(model, req.reasoningEffort);
  if (thinking) {
    if (thinking.kind === 'level') {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingLevel: thinking.effort.toUpperCase(),
      };
    } else if (thinking.kind === 'budget') {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: thinking.budget,
      };
    } else {
      generationConfig.thinkingConfig = { includeThoughts: true };
    }
  }

  return {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    tools:
      req.toolUseEnabled && req.tools.length > 0
        ? [
            {
              functionDeclarations: toGeminiFunctionDeclarations(req.tools, {
                rejectUnsupported: true,
              }),
            },
          ]
        : [],
    generationConfig,
  };
}

function isSyntheticId(id: string | undefined): boolean {
  return id?.startsWith('firebase_') ?? false;
}

function toArgsObject(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (args == null) return {};
  return { value: args };
}

function parseFunctionResponse(resultJson: string | undefined): Record<string, unknown> {
  const value = parseJsonValue(resultJson);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
}
