import type { ModelClientFactory, ModelEvent } from '@inbrowser/model';
import { createRelay } from '@inbrowser/relay';
import { createMemoryJobStore } from '@inbrowser/resumable';

export interface RelayBasicResult {
  jobId: string;
  events: ModelEvent[];
  resumedEvents: ModelEvent[];
  sawDone: boolean;
}

const fakeProvider: ModelClientFactory = ({ model }) => ({
  id: `fake:${model}`,
  supportsTools: true,
  async *chat() {
    yield { kind: 'thinking', text: 'Route request through resumable relay.' };
    yield { kind: 'text', text: `hello from ${model}` };
    yield { kind: 'usage', usage: { promptTokens: 12, outputTokens: 5 } };
  },
});

function makeStartRequest(): Request {
  return new Request('http://localhost/api/inference/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'fake',
      model: 'script-model',
      apiKey: 'demo-key',
      messages: [{ role: 'user', text: 'Say hello' }],
      tools: [],
      toolUseEnabled: false,
    }),
  });
}

async function readSseEvents(
  response: Response,
): Promise<{ events: ModelEvent[]; sawDone: boolean }> {
  const events: ModelEvent[] = [];
  let sawDone = false;
  const text = await response.text();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') {
      sawDone = true;
      continue;
    }
    events.push(JSON.parse(payload) as ModelEvent);
  }
  return { events, sawDone };
}

export async function runBasicRelayFlow(): Promise<RelayBasicResult> {
  const store = createMemoryJobStore<ModelEvent>();
  const relay = createRelay({ store, providers: { fake: fakeProvider } });

  try {
    const startResponse = await relay.handleStart(makeStartRequest());
    if (!startResponse.ok) throw new Error(`start failed: ${startResponse.status}`);
    const { jobId } = (await startResponse.json()) as { jobId: string };

    const stream = await relay.handleStream(
      new Request(`http://localhost/api/inference/job/${jobId}/stream`),
      { jobId },
    );
    const { events, sawDone } = await readSseEvents(stream);

    const resumed = await relay.handleStream(
      new Request(`http://localhost/api/inference/job/${jobId}/stream?from=1`),
      { jobId },
    );
    const resumedResult = await readSseEvents(resumed);

    return { jobId, events, resumedEvents: resumedResult.events, sawDone };
  } finally {
    await relay.stop();
  }
}

if (import.meta.main) {
  const result = await runBasicRelayFlow();

  console.log('\nRelay job');
  console.log(result.jobId);

  console.log('\nStreamed model events');
  for (const event of result.events) console.log(`- ${JSON.stringify(event)}`);

  console.log('\nResumed from offset 1');
  for (const event of result.resumedEvents) console.log(`- ${JSON.stringify(event)}`);

  console.log('\nDone marker');
  console.log(result.sawDone ? 'received [DONE]' : 'missing [DONE]');
}
