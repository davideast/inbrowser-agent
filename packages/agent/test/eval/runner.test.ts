import { describe, expect, test } from 'bun:test';
import type { RunRecord } from '../../src/eval/run-record.js';
import {
  type ChatEvent,
  type LlmClient,
  type RunFixturesDeps,
  type TaskFixture,
  type ToolHandler,
  createDispatch,
  createToolRegistry,
  runFixture,
  runFixtures,
} from '../../src/index.js';

/**
 * Build a fake LLM that yields a scripted sequence of `ChatEvent`s
 * per turn. The same instance can drive multiple turns because the
 * underlying ReAct loop calls `chat()` once per iteration.
 */
function fakeLlm(scripts: ChatEvent[][]): LlmClient {
  let turn = 0;
  return {
    id: 'fake',
    supportsTools: true,
    chat() {
      const events = scripts[turn] ?? [];
      turn += 1;
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
}

/** A canned `turn_complete` event reused across scripts. */
const turnComplete: ChatEvent = {
  kind: 'turn_complete',
  usage: { promptTokens: 1, completionTokens: 1 },
  details: { requestedModel: 'fake' },
};

/** Minimal valid fixture; tests override fields as needed. */
function makeFixture(overrides: Partial<TaskFixture> = {}): TaskFixture {
  return {
    id: 'firestore-rules-audit/runner-test',
    skill: 'firestore-rules-audit',
    description: 'runner test fixture',
    prompt: 'Audit my rules.',
    successSpec: { name: 'firestore-rules-audit/passes' },
    ...overrides,
  };
}

function emptyDeps(llm: LlmClient): RunFixturesDeps {
  return {
    llm,
    tools: createDispatch(createToolRegistry()),
    toolList: [],
  };
}

describe('runFixture', () => {
  test('drives a no-tool fixture to completion and captures a trace', async () => {
    const llm = fakeLlm([[{ kind: 'text', chunk: 'all good' }, turnComplete]]);
    const record = await runFixture({
      fixture: makeFixture(),
      llm,
      tools: createDispatch(createToolRegistry()),
      toolList: [],
    });

    expect(record.error).toBeNull();
    expect(record.assistantText).toBe('all good');
    expect(record.trial).toBe(0);
    expect(record.completedAt).toBeGreaterThanOrEqual(record.startedAt);

    const kinds = record.trace.map((e) => e.kind);
    expect(kinds).toContain('llm_request');
    expect(kinds).toContain('llm_response');
    // No tool calls → no turn_dispatch_complete event.
    expect(kinds).not.toContain('turn_dispatch_complete');
  });

  test('captures turn_dispatch_complete when a tool call runs', async () => {
    const writeRules: ToolHandler<{ source: string }> = {
      name: 'writeRules',
      description: 'write rules',
      parameters: { type: 'object' },
      async execute({ source }) {
        return {
          ok: true,
          summary: `wrote ${source.length} chars`,
          workspacePatch: { rules: source },
        };
      },
    };
    const registry = createToolRegistry();
    registry.register(writeRules);

    const llm = fakeLlm([
      [
        {
          kind: 'tool_call',
          id: 'c1',
          name: 'writeRules',
          args: { source: 'rules_version="2"' },
        },
        turnComplete,
      ],
      [{ kind: 'text', chunk: 'done' }, turnComplete],
    ]);

    const record = await runFixture({
      fixture: makeFixture(),
      llm,
      tools: createDispatch(registry),
      toolList: registry.list(),
    });

    expect(record.error).toBeNull();
    const kinds = record.trace.map((e) => e.kind);
    expect(kinds).toContain('llm_request');
    expect(kinds).toContain('llm_response');
    expect(kinds).toContain('turn_dispatch_complete');
    // Shadow workspace must reflect the tool's workspacePatch.
    expect(record.finalWorkspace.rules).toBe('rules_version="2"');
  });

  test('seeds the workspace from the fixture initialState', async () => {
    const llm = fakeLlm([[{ kind: 'text', chunk: 'noted' }, turnComplete]]);
    const fixture = makeFixture({
      initialState: { rules: 'seeded-rules', code: 'seeded-code' },
    });
    const record = await runFixture({
      fixture,
      llm,
      tools: createDispatch(createToolRegistry()),
      toolList: [],
    });

    expect(record.error).toBeNull();
    expect(record.finalWorkspace.rules).toBe('seeded-rules');
    expect(record.finalWorkspace.code).toBe('seeded-code');
    // The system prompt the strategy saw must mention the seeded
    // rules — that is the only way the agent ever sees fixture state
    // when no tool reads `ctx.workspace`.
    const req = record.trace.find((e) => e.kind === 'llm_request');
    expect(req).toBeDefined();
    if (req && req.kind === 'llm_request') {
      expect(req.data.systemPrompt).toContain('seeded-rules');
    }
  });

  test('aborting mid-flight resolves with error set and a partial trace', async () => {
    // The LLM yields one event then yields forever — we abort to
    // break out. The session emits an `error` event when it observes
    // the aborted signal.
    const controller = new AbortController();
    let started = false;
    const llm: LlmClient = {
      id: 'slow',
      supportsTools: true,
      chat(_req, signal) {
        return (async function* () {
          started = true;
          yield { kind: 'text', chunk: 'partial...' } as ChatEvent;
          // Wait until aborted, then yield error.
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
            // Also fire the external controller almost immediately
            // so the test does not depend on real time.
            setTimeout(() => controller.abort(), 5);
          });
          yield { kind: 'error', message: 'aborted by signal' } as ChatEvent;
        })();
      },
    };

    const record = await runFixture({
      fixture: makeFixture(),
      llm,
      tools: createDispatch(createToolRegistry()),
      toolList: [],
      signal: controller.signal,
    });

    expect(started).toBe(true);
    expect(record.error).not.toBeNull();
    expect(record.assistantText).toBe('partial...');
    // Trace is partial: we saw the request but the response may or
    // may not have fired depending on timing — both are acceptable.
    const kinds = record.trace.map((e) => e.kind);
    expect(kinds).toContain('llm_request');
  });

  test('exceeding maxWallClockMs terminates with a clear error', async () => {
    const llm: LlmClient = {
      id: 'hang',
      supportsTools: true,
      chat(_req, signal) {
        return (async function* () {
          yield { kind: 'text', chunk: 'thinking' } as ChatEvent;
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          yield { kind: 'error', message: 'aborted' } as ChatEvent;
        })();
      },
    };

    const record = await runFixture({
      fixture: makeFixture(),
      llm,
      tools: createDispatch(createToolRegistry()),
      toolList: [],
      maxWallClockMs: 20,
    });

    expect(record.error).not.toBeNull();
    expect(record.error).toContain('maxWallClockMs');
  });

  test('echoes seed onto the produced record when provided', async () => {
    const llm = fakeLlm([[{ kind: 'text', chunk: 'ok' }, turnComplete]]);
    const record = await runFixture({
      fixture: makeFixture(),
      llm,
      tools: createDispatch(createToolRegistry()),
      toolList: [],
      seed: 1234,
    });
    expect(record.seed).toBe(1234);
  });

  test('records a session-emitted error in RunRecord.error', async () => {
    const llm: LlmClient = {
      id: 'broken',
      supportsTools: true,
      chat() {
        return (async function* () {
          yield { kind: 'error', message: 'provider exploded' } as ChatEvent;
        })();
      },
    };
    const record = await runFixture({
      fixture: makeFixture(),
      llm,
      tools: createDispatch(createToolRegistry()),
      toolList: [],
    });
    expect(record.error).toContain('provider exploded');
  });
});

describe('runFixtures', () => {
  test('returns N trials per fixture in input order', async () => {
    // Each call to chat() corresponds to one strategy iteration. A
    // no-tool fixture takes one iteration, and we run 3 trials for 2
    // fixtures → 6 total scripts.
    const scripts: ChatEvent[][] = Array.from({ length: 6 }, (_, i) => [
      { kind: 'text', chunk: `t${i}` },
      turnComplete,
    ]);
    const llm = fakeLlm(scripts);

    const fixtures: TaskFixture[] = [
      makeFixture({ id: 'firestore-rules-audit/a' }),
      makeFixture({ id: 'firestore-rules-audit/b' }),
    ];
    const records = await runFixtures(fixtures, emptyDeps(llm), { trials: 3 });
    expect(records.length).toBe(6);

    // Verify (fixture, trial) ordering: trials 0..2 of fixture a,
    // then trials 0..2 of fixture b.
    const ordering = records.map((r: RunRecord) => `${r.fixture.id}#${r.trial}`);
    expect(ordering).toEqual([
      'firestore-rules-audit/a#0',
      'firestore-rules-audit/a#1',
      'firestore-rules-audit/a#2',
      'firestore-rules-audit/b#0',
      'firestore-rules-audit/b#1',
      'firestore-rules-audit/b#2',
    ]);

    // Each record is its own RunRecord — traces are independent.
    expect(records[0]?.assistantText).toBe('t0');
    expect(records[5]?.assistantText).toBe('t5');
  });

  test('defaults to one trial per fixture when trials is omitted', async () => {
    const llm = fakeLlm([[{ kind: 'text', chunk: 'once' }, turnComplete]]);
    const records = await runFixtures([makeFixture()], emptyDeps(llm));
    expect(records.length).toBe(1);
    expect(records[0]?.trial).toBe(0);
  });

  test('threads seed factory through to each record', async () => {
    const scripts: ChatEvent[][] = Array.from({ length: 2 }, () => [
      { kind: 'text', chunk: 'ok' },
      turnComplete,
    ]);
    const llm = fakeLlm(scripts);
    const records = await runFixtures([makeFixture()], emptyDeps(llm), {
      trials: 2,
      seed: (_f, trial) => 1000 + trial,
    });
    expect(records[0]?.seed).toBe(1000);
    expect(records[1]?.seed).toBe(1001);
  });

  test('short-circuits remaining trials when the external signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = fakeLlm([]);
    const records = await runFixtures(
      [makeFixture(), makeFixture({ id: 'firestore-rules-audit/b' })],
      emptyDeps(llm),
      {
        trials: 2,
        signal: controller.signal,
      },
    );
    expect(records.length).toBe(4);
    for (const r of records) {
      expect(r.error).toContain('aborted');
    }
  });
});
