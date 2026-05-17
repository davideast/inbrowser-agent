/**
 * Smoke tests — wire createRelay to a memory store + a fake provider,
 * exercise handleStart + handleStream end-to-end as Web `Request` →
 * `Response`. The full conformance tests for the underlying store +
 * engine live in @inbrowser/resumable; these tests assert the relay-level
 * behaviors (provider routing, SSE shape, terminal-marker handling,
 * reconnect-with-from).
 */
import { describe, expect, it } from 'bun:test';
import { createMemoryJobStore } from '@inbrowser/resumable/memory';
import { createRelay } from '../src/relay';
import type { InferenceEvent, InferenceProvider, NormalizedRequest } from '../src/types';

const fakeProvider: InferenceProvider = async function* (req) {
  yield { kind: 'text', chunk: `hello from ${req.provider}/${req.model}` };
  yield { kind: 'text', chunk: ' (more text)' };
  yield {
    kind: 'usage',
    promptTokens: 10,
    outputTokens: 5,
  };
};

const failingProvider: InferenceProvider = async function* () {
  yield { kind: 'error', message: 'simulated upstream failure' };
};

async function readSseEvents(
  res: Response,
): Promise<{ events: unknown[]; sawDone: boolean }> {
  const events: unknown[] = [];
  let sawDone = false;
  const text = await res.text();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') {
      sawDone = true;
      continue;
    }
    events.push(JSON.parse(payload));
  }
  return { events, sawDone };
}

function makeStartRequest(body: Partial<NormalizedRequest>): Request {
  return new Request('http://localhost/api/inference/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'fake',
      model: 'm',
      messages: [],
      tools: [],
      apiKey: 'sk-test',
      ...body,
    }),
  });
}

describe('createRelay', () => {
  it('starts a job + streams events + emits [DONE] on terminal', async () => {
    const store = createMemoryJobStore<InferenceEvent>();
    const relay = createRelay({ store, providers: { fake: fakeProvider } });

    const startRes = await relay.handleStart(makeStartRequest({}));
    expect(startRes.status).toBe(201);
    const { jobId } = (await startRes.json()) as { jobId: string };
    expect(jobId).toBeTruthy();

    const streamRes = await relay.handleStream(
      new Request(`http://localhost/api/inference/job/${jobId}/stream`),
      { jobId },
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toBe('text/event-stream');

    const { events, sawDone } = await readSseEvents(streamRes);
    expect(sawDone).toBe(true);
    expect(events.length).toBe(3);
    expect(events[0]).toEqual({ kind: 'text', chunk: 'hello from fake/m' });

    await relay.stop();
  });

  it('rejects an unknown provider with 400', async () => {
    const store = createMemoryJobStore<InferenceEvent>();
    const relay = createRelay({ store, providers: { fake: fakeProvider } });

    const res = await relay.handleStart(makeStartRequest({ provider: 'nope' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('unknown provider');

    await relay.stop();
  });

  it('requires provider and apiKey', async () => {
    const store = createMemoryJobStore<InferenceEvent>();
    const relay = createRelay({ store, providers: { fake: fakeProvider } });

    const res = await relay.handleStart(
      new Request('http://localhost/api/inference/job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [], tools: [] }),
      }),
    );
    expect(res.status).toBe(400);

    await relay.stop();
  });

  it('streams resume from `from` offset', async () => {
    const store = createMemoryJobStore<InferenceEvent>();
    const relay = createRelay({ store, providers: { fake: fakeProvider } });

    const { jobId } = (await (await relay.handleStart(makeStartRequest({}))).json()) as {
      jobId: string;
    };

    // Drain once.
    await readSseEvents(
      await relay.handleStream(
        new Request(`http://localhost/api/inference/job/${jobId}/stream`),
        { jobId },
      ),
    );

    // Resume from seq 2 — should yield only the usage event + DONE.
    const resumed = await relay.handleStream(
      new Request(`http://localhost/api/inference/job/${jobId}/stream?from=2`),
      { jobId },
    );
    const { events, sawDone } = await readSseEvents(resumed);
    expect(sawDone).toBe(true);
    expect(events.length).toBe(1);
    expect((events[0] as { kind: string }).kind).toBe('usage');

    await relay.stop();
  });

  it('returns 404 for an unknown job', async () => {
    const store = createMemoryJobStore<InferenceEvent>();
    const relay = createRelay({ store, providers: { fake: fakeProvider } });

    const res = await relay.handleStream(
      new Request('http://localhost/api/inference/job/missing/stream'),
      { jobId: 'missing' },
    );
    expect(res.status).toBe(404);

    await relay.stop();
  });

  it('propagates a provider error as a kind:error event followed by [DONE]', async () => {
    const store = createMemoryJobStore<InferenceEvent>();
    const relay = createRelay({ store, providers: { fail: failingProvider } });

    const { jobId } = (await (await relay.handleStart(makeStartRequest({ provider: 'fail' }))).json()) as {
      jobId: string;
    };

    const { events, sawDone } = await readSseEvents(
      await relay.handleStream(
        new Request(`http://localhost/api/inference/job/${jobId}/stream`),
        { jobId },
      ),
    );
    expect(sawDone).toBe(true);
    expect(events.find((e) => (e as { kind: string }).kind === 'error')).toEqual({
      kind: 'error',
      message: 'simulated upstream failure',
    });

    await relay.stop();
  });

  it('stores provider/model in the job data', async () => {
    const store = createMemoryJobStore<InferenceEvent>();
    const relay = createRelay({ store, providers: { fake: fakeProvider } });

    const { jobId } = (await (await relay.handleStart(makeStartRequest({ model: 'special' }))).json()) as {
      jobId: string;
    };

    await readSseEvents(
      await relay.handleStream(
        new Request(`http://localhost/api/inference/job/${jobId}/stream`),
        { jobId },
      ),
    );

    const snap = await relay.engine.get(jobId);
    expect(snap?.data).toEqual({ provider: 'fake', model: 'special' });

    await relay.stop();
  });
});
