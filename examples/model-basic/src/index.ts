import {
  type EngineEvent,
  type ModelUsage,
  normalizeModelUsage,
  parseToolCalls,
  splitThinking,
  sumModelUsage,
} from '@inbrowser/model';

export interface ModelBasicResult {
  events: EngineEvent[];
  answerText: string;
  thinkingText: string;
  toolNames: string[];
  usage: ModelUsage;
}

async function* tokenStream(): AsyncIterable<EngineEvent> {
  yield { kind: 'token', text: 'Before <think>Need current package docs</think> ' };
  yield {
    kind: 'token',
    text: '<tool_call>{"name":"search_docs","arguments":{"q":"workspace"}}</tool_call> ',
  };
  yield { kind: 'token', text: 'Use the workspace package for files and shell.' };
}

async function collectEvents(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const collected: EngineEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

export async function runBasicModelFlow(): Promise<ModelBasicResult> {
  const events = await collectEvents(
    parseToolCalls(splitThinking(tokenStream()), { generateId: () => 'tool_demo_1' }),
  );
  const answerText = events
    .filter((event): event is Extract<EngineEvent, { kind: 'token' }> => event.kind === 'token')
    .map((event) => event.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const thinkingText = events
    .filter(
      (event): event is Extract<EngineEvent, { kind: 'thinking' }> => event.kind === 'thinking',
    )
    .map((event) => event.text)
    .join('')
    .trim();
  const toolNames = events
    .filter(
      (event): event is Extract<EngineEvent, { kind: 'tool_call' }> => event.kind === 'tool_call',
    )
    .map((event) => event.name);
  const usage = sumModelUsage([
    normalizeModelUsage({ promptTokens: 18, outputTokens: 8, cachedTokens: 4 }),
    normalizeModelUsage({ promptTokens: 7, outputTokens: 6, reasoningTokens: 3, costUsd: 0.002 }),
  ]);

  return { events, answerText, thinkingText, toolNames, usage };
}

if (import.meta.main) {
  const result = await runBasicModelFlow();

  console.log('\nModel event stream');
  for (const event of result.events) {
    if (event.kind === 'tool_call') {
      console.log(`- tool_call ${event.name} ${JSON.stringify(event.args)}`);
    } else if (event.kind === 'thinking' || event.kind === 'token') {
      console.log(`- ${event.kind} ${event.text.trim()}`);
    }
  }

  console.log('\nAnswer');
  console.log(result.answerText);

  console.log('\nThinking');
  console.log(result.thinkingText);

  console.log('\nUsage');
  console.log(JSON.stringify(result.usage, null, 2));
}
