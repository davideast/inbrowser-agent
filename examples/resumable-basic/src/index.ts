import { type JobEvent, createJobEngine, createMemoryJobStore } from '@inbrowser/resumable';

export interface ResumableBasicResult {
  jobId: string;
  allEvents: JobEvent<string>[];
  resumedEvents: JobEvent<string>[];
  snapshotEvents: string[];
  status: string;
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

export async function runBasicResumableFlow(): Promise<ResumableBasicResult> {
  const store = createMemoryJobStore<string>();
  const engine = createJobEngine({ store });

  try {
    const { jobId } = await engine.start(
      async function* () {
        yield 'plan';
        yield 'write files';
        yield 'finish';
      },
      { data: { demo: 'resumable-basic' } },
    );

    const allEvents = await collect(engine.subscribe(jobId));
    const resumedEvents = await collect(engine.subscribe(jobId, { from: 1 }));
    const snapshot = await engine.get(jobId);

    return {
      jobId,
      allEvents,
      resumedEvents,
      snapshotEvents: snapshot?.events ?? [],
      status: snapshot?.status ?? 'missing',
    };
  } finally {
    await engine.stop();
  }
}

if (import.meta.main) {
  const result = await runBasicResumableFlow();

  console.log('\nJob');
  console.log(result.jobId);

  console.log('\nInitial subscription');
  for (const event of result.allEvents) console.log(`- ${JSON.stringify(event)}`);

  console.log('\nResumed from offset 1');
  for (const event of result.resumedEvents) console.log(`- ${JSON.stringify(event)}`);

  console.log('\nSnapshot');
  console.log(`${result.status}: ${result.snapshotEvents.join(' -> ')}`);
}
