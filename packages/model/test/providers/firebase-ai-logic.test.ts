import { describe, expect, test } from 'bun:test';
import type { ModelEvent, ModelRequest } from '../../src/index';
import {
  type FirebaseAiLogicGenerativeModelLike,
  createFirebaseAiLogicModelClient,
} from '../../src/providers/firebase-ai-logic';

async function collect(source: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function scriptedModel(
  chunks: unknown[],
  modelId = 'models/gemini-3.5-flash',
  aggregateResponse: unknown = {},
): {
  model: FirebaseAiLogicGenerativeModelLike;
  requests: unknown[];
  signals: Array<AbortSignal | undefined>;
} {
  const requests: unknown[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  return {
    requests,
    signals,
    model: {
      model: modelId,
      async generateContentStream(request, options) {
        requests.push(request);
        signals.push(options?.signal);
        return {
          stream: (async function* () {
            for (const chunk of chunks) yield chunk;
          })(),
          response: Promise.resolve(aggregateResponse),
        };
      },
    },
  };
}

describe('Firebase AI Logic provider', () => {
  test('wraps a constructed Firebase model as a ModelClient', () => {
    const model = {
      model: 'models/gemini-3.5-flash',
      async generateContentStream() {
        return {
          stream: (async function* () {})(),
          response: Promise.resolve({}),
        };
      },
    };

    const client = createFirebaseAiLogicModelClient(model);

    expect(client.id).toBe('firebase-ai-logic:models/gemini-3.5-flash');
    expect(client.supportsTools).toBe(true);
    expect(typeof client.chat).toBe('function');
  });

  test('maps a text conversation and streams text with final usage', async () => {
    const fake = scriptedModel([
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Hello back.' }] },
            finishReason: 'STOP',
          },
        ],
      },
      {
        usageMetadata: {
          promptTokenCount: 11,
          candidatesTokenCount: 3,
        },
      },
    ]);
    const client = createFirebaseAiLogicModelClient(fake.model);
    const signal = new AbortController().signal;
    const request: ModelRequest = {
      messages: [
        { role: 'system', text: 'Be concise.' },
        { role: 'user', text: 'Hello' },
        { role: 'assistant', text: 'Earlier answer.' },
      ],
      tools: [],
      toolUseEnabled: false,
      temperature: 0.2,
      topP: 0.8,
      topK: 20,
    };

    const events = await collect(client.chat(request, signal));

    expect(fake.requests).toEqual([
      {
        contents: [
          { role: 'user', parts: [{ text: 'Hello' }] },
          { role: 'model', parts: [{ text: 'Earlier answer.' }] },
        ],
        systemInstruction: 'Be concise.',
        tools: [],
        generationConfig: {
          maxOutputTokens: 65_536,
          temperature: 0.2,
          topP: 0.8,
          topK: 20,
        },
      },
    ]);
    expect(fake.signals).toEqual([signal]);
    expect(events).toEqual([
      { kind: 'text', text: 'Hello back.' },
      { kind: 'usage', usage: { promptTokens: 11, outputTokens: 3 } },
    ]);
  });

  test('maps reasoning effort and uses the latest streamed usage snapshot', async () => {
    const fake = scriptedModel([
      {
        candidates: [{ content: { parts: [{ text: 'Planning.', thought: true }] } }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 1,
          cachedContentTokenCount: 0,
          thoughtsTokenCount: 1,
        },
      },
      {
        candidates: [
          {
            content: { parts: [{ text: 'Done.' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 3,
          cachedContentTokenCount: 4,
          thoughtsTokenCount: 2,
        },
      },
    ]);
    const client = createFirebaseAiLogicModelClient(fake.model, { temperature: 0.15 });

    const events = await collect(
      client.chat(
        {
          messages: [{ role: 'user', text: 'Solve it.' }],
          tools: [],
          toolUseEnabled: false,
          reasoningEffort: 'medium',
        },
        new AbortController().signal,
      ),
    );

    expect(fake.requests).toEqual([
      {
        contents: [{ role: 'user', parts: [{ text: 'Solve it.' }] }],
        tools: [],
        generationConfig: {
          maxOutputTokens: 65_536,
          temperature: 0.15,
          thinkingConfig: { includeThoughts: true, thinkingLevel: 'MEDIUM' },
        },
      },
    ]);
    expect(events).toEqual([
      { kind: 'thinking', text: 'Planning.' },
      { kind: 'text', text: 'Done.' },
      {
        kind: 'usage',
        usage: {
          promptTokens: 12,
          outputTokens: 3,
          cachedTokens: 4,
          reasoningTokens: 2,
        },
      },
    ]);
  });

  test('maps Gemini 2.5 reasoning to a budget and leaves off unset', async () => {
    const fake = scriptedModel(
      [
        {
          candidates: [
            {
              content: { parts: [{ text: 'Answer.' }] },
              finishReason: 'STOP',
            },
          ],
        },
      ],
      'models/gemini-2.5-flash',
    );
    const client = createFirebaseAiLogicModelClient(fake.model);
    const baseRequest: Omit<ModelRequest, 'reasoningEffort'> = {
      messages: [{ role: 'user', text: 'Question' }],
      tools: [],
      toolUseEnabled: false,
    };

    await collect(
      client.chat({ ...baseRequest, reasoningEffort: 'high' }, new AbortController().signal),
    );
    await collect(
      client.chat({ ...baseRequest, reasoningEffort: 'off' }, new AbortController().signal),
    );

    const requests = fake.requests as Array<{ generationConfig: Record<string, unknown> }>;
    expect(requests[0].generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 8192,
    });
    expect(requests[1].generationConfig.thinkingConfig).toBeUndefined();
  });

  test('advertises sanitized function tools only when tool use is enabled', async () => {
    const fake = scriptedModel([
      {
        candidates: [
          {
            content: { parts: [{ text: 'Answer.' }] },
            finishReason: 'STOP',
          },
        ],
      },
    ]);
    const client = createFirebaseAiLogicModelClient(fake.model);
    const toolRequest: ModelRequest = {
      messages: [{ role: 'user', text: 'Search' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'search_docs',
            description: 'Search documentation',
            parameters: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
              properties: {
                query: { type: 'string', default: 'all' },
                maximum: { type: 'number', minimum: 0, maximum: 10 },
                choice: {
                  anyOf: [{ type: 'string' }, { type: 'number' }],
                },
              },
              required: ['query'],
              additionalProperties: false,
            },
          },
        },
      ],
      toolUseEnabled: true,
    };

    await collect(client.chat(toolRequest, new AbortController().signal));
    await collect(
      client.chat({ ...toolRequest, toolUseEnabled: false }, new AbortController().signal),
    );

    const requests = fake.requests as Array<{ tools: unknown[] }>;
    expect(requests[0].tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'search_docs',
            description: 'Search documentation',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                maximum: { type: 'number', minimum: 0, maximum: 10 },
                choice: {
                  anyOf: [{ type: 'string' }, { type: 'number' }],
                },
              },
              required: ['query'],
            },
          },
        ],
      },
    ]);
    expect(requests[1].tools).toEqual([]);
  });

  test('collapses cumulative function-call chunks and preserves id and thought signature', async () => {
    const fake = scriptedModel([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { id: 'call-7', name: 'lookup', args: {} } }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call-7',
                    name: 'lookup',
                    args: { query: 'firebase' },
                  },
                  thoughtSignature: 'sig-7',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
      },
    ]);
    const client = createFirebaseAiLogicModelClient(fake.model);

    const events = await collect(
      client.chat(
        {
          messages: [{ role: 'user', text: 'Find it.' }],
          tools: [],
          toolUseEnabled: false,
        },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      {
        kind: 'tool_call',
        id: 'call-7',
        name: 'lookup',
        args: { query: 'firebase' },
        signature: 'sig-7',
      },
      { kind: 'usage', usage: { promptTokens: 8, outputTokens: 2 } },
    ]);
  });

  test('keeps distinct idless function calls from separate delta chunks', async () => {
    const fake = scriptedModel([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'lookup_first', args: { query: 'first' } },
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'lookup_second', args: { query: 'second' } },
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ]);
    const client = createFirebaseAiLogicModelClient(fake.model);

    const events = await collect(
      client.chat(
        {
          messages: [{ role: 'user', text: 'Find it.' }],
          tools: [],
          toolUseEnabled: false,
        },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      {
        kind: 'tool_call',
        id: 'firebase_0',
        name: 'lookup_first',
        args: { query: 'first' },
      },
      {
        kind: 'tool_call',
        id: 'firebase_1',
        name: 'lookup_second',
        args: { query: 'second' },
      },
      { kind: 'usage', usage: { promptTokens: 0, outputTokens: 0 } },
    ]);
  });

  test('replays an assistant function call and its result with signature and upstream id', async () => {
    const fake = scriptedModel([
      {
        candidates: [
          {
            content: { parts: [{ text: 'Two matches.' }] },
            finishReason: 'STOP',
          },
        ],
      },
    ]);
    const client = createFirebaseAiLogicModelClient(fake.model);

    await collect(
      client.chat(
        {
          messages: [
            { role: 'user', text: 'Find it.' },
            {
              role: 'assistant',
              toolCalls: [
                {
                  id: 'call-7',
                  name: 'lookup',
                  args: { query: 'firebase' },
                  signature: 'sig-7',
                },
              ],
            },
            {
              role: 'tool',
              toolCallId: 'call-7',
              name: 'lookup',
              resultJson: '{"hits":2}',
            },
          ],
          tools: [],
          toolUseEnabled: false,
        },
        new AbortController().signal,
      ),
    );

    expect(fake.requests).toEqual([
      {
        contents: [
          { role: 'user', parts: [{ text: 'Find it.' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-7',
                  name: 'lookup',
                  args: { query: 'firebase' },
                },
                thoughtSignature: 'sig-7',
              },
            ],
          },
          {
            role: 'function',
            parts: [
              {
                functionResponse: {
                  id: 'call-7',
                  name: 'lookup',
                  response: { hits: 2 },
                },
              },
            ],
          },
        ],
        tools: [],
        generationConfig: { maxOutputTokens: 65_536 },
      },
    ]);
  });

  test('omits locally synthesized function-call ids when replaying Firebase history', async () => {
    const fake = scriptedModel([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'lookup', args: { query: 'firebase' } },
                  thoughtSignature: 'sig-local',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ]);
    const client = createFirebaseAiLogicModelClient(fake.model);

    const firstEvents = await collect(
      client.chat(
        {
          messages: [{ role: 'user', text: 'Find it.' }],
          tools: [],
          toolUseEnabled: false,
        },
        new AbortController().signal,
      ),
    );

    expect(firstEvents[0]).toEqual({
      kind: 'tool_call',
      id: 'firebase_0',
      name: 'lookup',
      args: { query: 'firebase' },
      signature: 'sig-local',
    });

    await collect(
      client.chat(
        {
          messages: [
            { role: 'user', text: 'Find it.' },
            {
              role: 'assistant',
              toolCalls: [
                {
                  id: 'firebase_0',
                  name: 'lookup',
                  args: { query: 'firebase' },
                  signature: 'sig-local',
                },
              ],
            },
            {
              role: 'tool',
              toolCallId: 'firebase_0',
              name: 'lookup',
              resultJson: '{"hits":2}',
            },
          ],
          tools: [],
          toolUseEnabled: false,
        },
        new AbortController().signal,
      ),
    );

    expect(fake.requests[1]).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'Find it.' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'lookup',
                args: { query: 'firebase' },
              },
              thoughtSignature: 'sig-local',
            },
          ],
        },
        {
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: 'lookup',
                response: { hits: 2 },
              },
            },
          ],
        },
      ],
      tools: [],
      generationConfig: { maxOutputTokens: 65_536 },
    });
  });

  test('coalesces adjacent tool results and normalizes non-object result values', async () => {
    const fake = scriptedModel([
      {
        candidates: [
          {
            content: { parts: [{ text: 'Combined.' }] },
            finishReason: 'STOP',
          },
        ],
      },
    ]);
    const client = createFirebaseAiLogicModelClient(fake.model);

    await collect(
      client.chat(
        {
          messages: [
            { role: 'user', text: 'Run both.' },
            {
              role: 'tool',
              toolCallId: 'call-1',
              name: 'first',
              resultJson: '42',
            },
            {
              role: 'tool',
              toolCallId: 'call-2',
              name: 'second',
              resultJson: '["a","b"]',
            },
            { role: 'user', text: 'Summarize.' },
          ],
          tools: [],
          toolUseEnabled: false,
        },
        new AbortController().signal,
      ),
    );

    expect(fake.requests[0]).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'Run both.' }] },
        {
          role: 'function',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'first',
                response: { result: 42 },
              },
            },
            {
              functionResponse: {
                id: 'call-2',
                name: 'second',
                response: { result: ['a', 'b'] },
              },
            },
          ],
        },
        { role: 'user', parts: [{ text: 'Summarize.' }] },
      ],
      tools: [],
      generationConfig: { maxOutputTokens: 65_536 },
    });
  });

  test('normalizes a retryable Firebase AI error as the terminal event', async () => {
    const firebaseError = Object.assign(new Error('Firebase AI rate limited'), {
      code: 'fetch-error',
      customErrorData: {
        status: 429,
        statusText: 'Too Many Requests',
        errorDetails: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
      },
    });
    const model: FirebaseAiLogicGenerativeModelLike = {
      model: 'models/gemini-3.5-flash',
      async generateContentStream() {
        throw firebaseError;
      },
    };
    const client = createFirebaseAiLogicModelClient(model);

    const events = await collect(
      client.chat(
        {
          messages: [{ role: 'user', text: 'Hello' }],
          tools: [],
          toolUseEnabled: false,
        },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      {
        kind: 'error',
        message: 'Firebase AI rate limited',
        code: 'firebase-ai-logic.fetch-error',
        retryable: true,
        details: {
          status: 429,
          statusText: 'Too Many Requests',
          errorDetails: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
        },
      },
    ]);
  });

  test('marks deterministic Firebase AI request errors as non-retryable', async () => {
    const firebaseError = Object.assign(new Error('Invalid conversation content'), {
      code: 'ai/invalid-content',
      customErrorData: { status: 400, statusText: 'Bad Request' },
    });
    const model: FirebaseAiLogicGenerativeModelLike = {
      model: 'models/gemini-3.5-flash',
      async generateContentStream() {
        throw firebaseError;
      },
    };
    const client = createFirebaseAiLogicModelClient(model);

    const events = await collect(
      client.chat(
        {
          messages: [{ role: 'user', text: 'Hello' }],
          tools: [],
          toolUseEnabled: false,
        },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      {
        kind: 'error',
        message: 'Invalid conversation content',
        code: 'firebase-ai-logic.invalid-content',
        retryable: false,
        details: { status: 400, statusText: 'Bad Request' },
      },
    ]);
  });

  test('rejects unsupported Firebase function-schema keywords before the SDK call', async () => {
    let calls = 0;
    const model: FirebaseAiLogicGenerativeModelLike = {
      model: 'models/gemini-3.5-flash',
      async generateContentStream() {
        calls += 1;
        return {
          stream: (async function* () {})(),
          response: Promise.resolve({}),
        };
      },
    };
    const client = createFirebaseAiLogicModelClient(model);

    const events = await collect(
      client.chat(
        {
          messages: [{ role: 'user', text: 'Choose.' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'choose',
                description: 'Choose a value',
                parameters: {
                  type: 'object',
                  properties: {
                    count: {
                      oneOf: [{ type: 'number' }, { type: 'string' }],
                    },
                  },
                },
              },
            },
          ],
          toolUseEnabled: true,
        },
        new AbortController().signal,
      ),
    );

    expect(calls).toBe(0);
    expect(events).toEqual([
      {
        kind: 'error',
        message: 'Unsupported Gemini function schema keyword "oneOf" at $.properties.count.oneOf',
        code: 'firebase-ai-logic.invalid-tool-schema',
        retryable: false,
        details: {
          keyword: 'oneOf',
          path: '$.properties.count.oneOf',
        },
      },
    ]);
  });

  test('reads a blocked prompt from the aggregate response when the SDK stream is empty', async () => {
    const fake = scriptedModel([], 'models/gemini-3.5-flash', {
      promptFeedback: {
        blockReason: 'SAFETY',
        blockReasonMessage: 'The prompt was blocked.',
      },
    });
    const client = createFirebaseAiLogicModelClient(fake.model);

    const events = await collect(
      client.chat(
        {
          messages: [{ role: 'user', text: 'Hello' }],
          tools: [],
          toolUseEnabled: false,
        },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      {
        kind: 'error',
        message: 'Firebase AI Logic blocked the prompt: The prompt was blocked.',
        code: 'firebase-ai-logic.prompt_blocked',
        retryable: false,
        details: { blockReason: 'SAFETY' },
      },
    ]);
  });

  test('ends a candidate-level safety block with an error instead of usage', async () => {
    const fake = scriptedModel([
      {
        candidates: [
          {
            content: { parts: [{ text: 'Partial unsafe text.' }] },
            finishReason: 'SAFETY',
            finishMessage: 'Candidate matched a safety filter.',
          },
        ],
      },
    ]);
    const client = createFirebaseAiLogicModelClient(fake.model);

    const events = await collect(
      client.chat(
        {
          messages: [{ role: 'user', text: 'Hello' }],
          tools: [],
          toolUseEnabled: false,
        },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      { kind: 'text', text: 'Partial unsafe text.' },
      {
        kind: 'error',
        message:
          'Firebase AI Logic candidate was blocked due to SAFETY: Candidate matched a safety filter.',
        code: 'firebase-ai-logic.candidate_blocked',
        retryable: false,
        details: {
          finishReason: 'SAFETY',
          finishMessage: 'Candidate matched a safety filter.',
        },
      },
    ]);
  });

  test('classifies blocked and no-output responses as terminal errors', async () => {
    const cases = [
      {
        chunk: {
          promptFeedback: {
            blockReason: 'SAFETY',
            blockReasonMessage: 'The prompt was blocked.',
          },
        },
        error: {
          kind: 'error',
          message: 'Firebase AI Logic blocked the prompt: The prompt was blocked.',
          code: 'firebase-ai-logic.prompt_blocked',
          retryable: false,
          details: { blockReason: 'SAFETY' },
        },
      },
      {
        chunk: {
          candidates: [
            {
              content: { parts: [{ text: 'Still thinking.', thought: true }] },
              finishReason: 'STOP',
            },
          ],
        },
        error: {
          kind: 'error',
          message:
            'Firebase AI Logic produced no output — finishReason=STOP (response ended after thinking only)',
          code: 'firebase-ai-logic.thinking_only_stop',
          retryable: true,
          details: {
            finishReason: 'STOP',
            sawThinking: true,
            sawVisibleText: false,
            sawFunctionCall: false,
          },
        },
      },
      {
        chunk: { usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 0 } },
        error: {
          kind: 'error',
          message:
            'Firebase AI Logic produced no output — finishReason=none (response ended with no visible output)',
          code: 'firebase-ai-logic.truncated_no_output',
          retryable: true,
          details: {
            finishReason: 'none',
            sawThinking: false,
            sawVisibleText: false,
            sawFunctionCall: false,
          },
        },
      },
      {
        chunk: {
          candidates: [
            {
              content: { parts: [{ functionCall: {} }] },
              finishReason: 'MALFORMED_FUNCTION_CALL',
            },
          ],
        },
        error: {
          kind: 'error',
          message:
            'Firebase AI Logic produced no output — finishReason=MALFORMED_FUNCTION_CALL (response ended with no visible output)',
          code: 'firebase-ai-logic.malformed_function_call',
          retryable: true,
          details: {
            finishReason: 'MALFORMED_FUNCTION_CALL',
            sawThinking: false,
            sawVisibleText: false,
            sawFunctionCall: false,
          },
        },
      },
    ] as const;

    for (const entry of cases) {
      const fake = scriptedModel([entry.chunk]);
      const client = createFirebaseAiLogicModelClient(fake.model);

      const events = await collect(
        client.chat(
          {
            messages: [{ role: 'user', text: 'Hello' }],
            tools: [],
            toolUseEnabled: false,
          },
          new AbortController().signal,
        ),
      );

      expect(events.at(-1)).toEqual(entry.error);
      expect(events.some((event) => event.kind === 'usage')).toBe(false);
    }
  });

  test('surfaces a mid-stream failure after prior output without a usage event', async () => {
    const failure = Object.assign(new Error('Stream disconnected'), {
      code: 'ai/fetch-error',
      customErrorData: { status: 503 },
    });
    const model: FirebaseAiLogicGenerativeModelLike = {
      model: 'models/gemini-3.5-flash',
      async generateContentStream() {
        return {
          stream: (async function* () {
            yield { candidates: [{ content: { parts: [{ text: 'Partial.' }] } }] };
            throw failure;
          })(),
          response: Promise.resolve({}),
        };
      },
    };
    const client = createFirebaseAiLogicModelClient(model);

    const events = await collect(
      client.chat(
        {
          messages: [{ role: 'user', text: 'Hello' }],
          tools: [],
          toolUseEnabled: false,
        },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      { kind: 'text', text: 'Partial.' },
      {
        kind: 'error',
        message: 'Stream disconnected',
        code: 'firebase-ai-logic.fetch-error',
        retryable: true,
        details: { status: 503 },
      },
    ]);
  });

  test('returns silently without calling Firebase when already aborted', async () => {
    let calls = 0;
    const model: FirebaseAiLogicGenerativeModelLike = {
      model: 'models/gemini-3.5-flash',
      async generateContentStream() {
        calls += 1;
        return {
          stream: (async function* () {})(),
          response: Promise.resolve({}),
        };
      },
    };
    const client = createFirebaseAiLogicModelClient(model);
    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      client.chat(
        {
          messages: [{ role: 'user', text: 'Hello' }],
          tools: [],
          toolUseEnabled: false,
        },
        controller.signal,
      ),
    );

    expect(calls).toBe(0);
    expect(events).toEqual([]);
  });

  test('stops consuming a stream as soon as the request is aborted', async () => {
    const controller = new AbortController();
    const model: FirebaseAiLogicGenerativeModelLike = {
      model: 'models/gemini-3.5-flash',
      async generateContentStream() {
        return {
          stream: (async function* () {
            yield { candidates: [{ content: { parts: [{ text: 'First.' }] } }] };
            controller.abort();
            yield {
              candidates: [
                {
                  content: { parts: [{ text: 'Must not be emitted.' }] },
                  finishReason: 'STOP',
                },
              ],
            };
          })(),
          response: Promise.resolve({}),
        };
      },
    };
    const client = createFirebaseAiLogicModelClient(model);

    const events = await collect(
      client.chat(
        {
          messages: [{ role: 'user', text: 'Hello' }],
          tools: [],
          toolUseEnabled: false,
        },
        controller.signal,
      ),
    );

    expect(events).toEqual([{ kind: 'text', text: 'First.' }]);
  });

  test('does not emit a terminal event when cancellation closes the stream', async () => {
    const controller = new AbortController();
    const model: FirebaseAiLogicGenerativeModelLike = {
      model: 'models/gemini-3.5-flash',
      async generateContentStream() {
        return {
          stream: (async function* () {
            yield { candidates: [{ content: { parts: [{ text: 'Partial.' }] } }] };
            controller.abort();
          })(),
          response: Promise.resolve({}),
        };
      },
    };
    const client = createFirebaseAiLogicModelClient(model);

    const events = await collect(
      client.chat(
        {
          messages: [{ role: 'user', text: 'Hello' }],
          tools: [],
          toolUseEnabled: false,
        },
        controller.signal,
      ),
    );

    expect(events).toEqual([{ kind: 'text', text: 'Partial.' }]);
  });
});
