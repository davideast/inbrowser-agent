/**
 * Phase four exit check.
 *
 * Runs the eval harness across a small subset of generative-style
 * fixtures twice — once with `reflexion: { enabled: false }` (baseline)
 * and once with `reflexion: { enabled: true }` (variant) — using a
 * wrong-then-right stub LLM at the `runFixture` level so the full
 * harness path is exercised end-to-end. Asserts the implementation
 * plan's phase four exit criterion:
 *
 *   - taskSuccessRate shows winner-variant on at least some fixtures
 *     and never winner-baseline (success rate strictly rises).
 *   - truthfulnessViolationRate never shows winner-baseline (no
 *     truthfulness regression).
 *
 * Cost metrics (wallClockMs, promptTokens, completionTokens) are
 * intentionally not asserted: reflexion adds at minimum a critique LLM
 * call and frequently a retry turn, so its predicted cost profile is
 * worse on those dimensions. The brief calls those trade-offs
 * acceptable.
 *
 * Fixtures: four synthetic in-memory fixtures patterned on the
 * generative skills. Each uses `report-mentions/at-least-one-of` —
 * the spec that evaluates `snapshot.assistantText`. The wrong-then-
 * right stub knows which tokens each fixture expects: the first
 * scripted turn emits text MISSING those tokens (success spec fails),
 * the critique returns `{ok: false}`, and on the retry the stub emits
 * text containing the tokens (success spec passes). With reflexion
 * off the strategy never reaches the second turn — task succeeds only
 * when reflexion is on.
 */

import { describe, expect, test } from 'bun:test';

import type { RunRecord } from '../../src/eval/run-record.js';
import { registerAllSpecs } from '../../src/eval/spec-helpers.js';
import {
  type ChatEvent,
  type ChatRequest,
  type LlmClient,
  type SpecResult,
  type TaskFixture,
  collectMetrics,
  compareMetrics,
  createDispatch,
  createReactLoopStrategy,
  createSpecRegistry,
  createToolRegistry,
  evaluateSpec,
  renderMarkdown,
  runFixture,
} from '../../src/index.js';

const TRIALS = 3;

// Four synthetic fixtures spanning all four generative skills. Each
// uses report-mentions/at-least-one-of because that spec evaluates
// assistantText — which is the surface the wrong-then-right stub
// controls. The token list is small (one or two distinctive tokens
// per fixture) so the stub can be terse.
const SUBSET_FIXTURES: readonly TaskFixture[] = [
  {
    id: 'reflexion-cmp/pyric-agents-lint-pass',
    skill: 'pyric-agents',
    description: 'reflexion-comparison synthetic: lint-pass token signal.',
    prompt: 'Generate Firestore rules and report that lint passes.',
    successSpec: {
      name: 'report-mentions/at-least-one-of',
      args: { tokens: ['lint-passed'] },
    },
  },
  {
    id: 'reflexion-cmp/playground-prompts-bid-tokens',
    skill: 'playground-prompts',
    description: 'reflexion-comparison synthetic: auction-prompt token signal.',
    prompt: 'Write a playground prompt about auction bids.',
    successSpec: {
      name: 'report-mentions/at-least-one-of',
      args: { tokens: ['highest-bid'] },
    },
  },
  {
    id: 'reflexion-cmp/rtdb-game-rules-turnguard',
    skill: 'rtdb-game-rules',
    description: 'reflexion-comparison synthetic: turnGuard token signal.',
    prompt: 'Write RTDB rules for a turn-based game.',
    successSpec: {
      name: 'report-mentions/at-least-one-of',
      args: { tokens: ['turnGuard'] },
    },
  },
  {
    id: 'reflexion-cmp/firestore-game-rules-winclaim',
    skill: 'firestore-game-rules',
    description: 'reflexion-comparison synthetic: winClaim token signal.',
    prompt: 'Write Firestore rules for a tic-tac-toe win-claim.',
    successSpec: {
      name: 'report-mentions/at-least-one-of',
      args: { tokens: ['winClaim'] },
    },
  },
];

/**
 * Map from fixture id → the magic token the success spec is checking
 * for. The stub uses this to emit text that succeeds on retry.
 */
const FIXTURE_TOKENS: Readonly<Record<string, string>> = {
  'reflexion-cmp/pyric-agents-lint-pass': 'lint-passed',
  'reflexion-cmp/playground-prompts-bid-tokens': 'highest-bid',
  'reflexion-cmp/rtdb-game-rules-turnguard': 'turnGuard',
  'reflexion-cmp/firestore-game-rules-winclaim': 'winClaim',
};

/**
 * Wrong-then-right stub. State machine, per `chat()` call:
 *   0: WRONG final-answer text (no magic token). turn_complete.
 *   1: critique → `{"ok": false, "feedback": "..."}`. turn_complete.
 *   2: RIGHT final-answer text (includes the magic token). turn_complete.
 *   3: critique → `{"ok": true}`. turn_complete.
 *   >=4: empty (defensive).
 *
 * Token spend on each turn is constant so the metric collector's
 * within-side spreads stay at zero — comparison labels are driven
 * purely by the across-side delta, not by stochastic noise.
 */
function createWrongThenRightStub(magicToken: string): LlmClient {
  let i = 0;
  return {
    id: 'reflexion-wrong-then-right-stub',
    supportsTools: true,
    chat(_req: ChatRequest): AsyncIterable<ChatEvent> {
      const current = i++;
      const completed: ChatEvent = {
        kind: 'turn_complete',
        usage: { promptTokens: 80, completionTokens: 20 },
        details: { requestedModel: 'reflexion-wrong-then-right-stub' },
      };
      const events: ChatEvent[] = [];
      if (current === 0) {
        events.push(
          {
            kind: 'text',
            chunk: 'Initial answer that omits the magic token by design.',
          },
          completed,
        );
      } else if (current === 1) {
        events.push(
          {
            kind: 'text',
            chunk: `{"ok": false, "feedback": "Response is missing the required '${magicToken}' signal."}`,
          },
          completed,
        );
      } else if (current === 2) {
        events.push(
          { kind: 'text', chunk: `Revised answer that includes ${magicToken}.` },
          completed,
        );
      } else if (current === 3) {
        events.push({ kind: 'text', chunk: '{"ok": true}' }, completed);
      }
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
}

async function runOneSide(
  fixtures: readonly TaskFixture[],
  reflexionEnabled: boolean,
): Promise<{ records: RunRecord[]; evaluations: SpecResult[] }> {
  const toolRegistry = createToolRegistry();
  const tools = createDispatch(toolRegistry);
  const specRegistry = createSpecRegistry();
  registerAllSpecs(specRegistry);

  const records: RunRecord[] = [];
  const evaluations: SpecResult[] = [];

  for (const fixture of fixtures) {
    const magicToken = FIXTURE_TOKENS[fixture.id];
    if (!magicToken) {
      throw new Error(`missing magic token for fixture ${fixture.id}`);
    }
    for (let trial = 0; trial < TRIALS; trial++) {
      const record = await runFixture({
        fixture,
        trial,
        llm: createWrongThenRightStub(magicToken),
        tools,
        toolList: [],
        strategy: createReactLoopStrategy({
          reflexion: { enabled: reflexionEnabled, maxRetries: 1 },
        }),
        maxWallClockMs: 10_000,
      });
      records.push(record);
      const evaluation = await evaluateSpec(specRegistry, fixture.successSpec, {
        finalWorkspace: record.finalWorkspace,
        finalRuntime: record.finalRuntime,
        assistantText: record.assistantText,
        trace: record.trace,
      });
      evaluations.push(evaluation);
    }
  }

  return { records, evaluations };
}

describe('reflexion comparison (phase four exit check)', () => {
  test(
    'reflexion lifts task success without regressing truthfulness',
    async () => {
      const baseline = await runOneSide(SUBSET_FIXTURES, false);
      const variant = await runOneSide(SUBSET_FIXTURES, true);

      const baselineTables = collectMetrics({
        records: baseline.records,
        evaluations: baseline.evaluations,
        toolRegistry: createToolRegistry(),
      });
      const variantTables = collectMetrics({
        records: variant.records,
        evaluations: variant.evaluations,
        toolRegistry: createToolRegistry(),
      });

      const report = compareMetrics({
        baseline: baselineTables,
        variant: variantTables,
        baselineName: 'no-reflexion',
        variantName: 'reflexion',
      });

      // Surface the head of the rendered report so the assertion's
      // context is visible in test output.
      const rendered = renderMarkdown(report);
      const head = rendered.split('\n').slice(0, 60).join('\n');
      // eslint-disable-next-line no-console
      console.log('\n=== reflexion comparison (first 60 lines) ===\n');
      // eslint-disable-next-line no-console
      console.log(head);

      // ---- compute per-side mean task success rates for the report ----
      const baselineSuccessMeans: number[] = [];
      const variantSuccessMeans: number[] = [];
      for (const t of baselineTables) {
        if (typeof t.aggregate.taskSuccessRate.mean === 'number') {
          baselineSuccessMeans.push(t.aggregate.taskSuccessRate.mean);
        }
      }
      for (const t of variantTables) {
        if (typeof t.aggregate.taskSuccessRate.mean === 'number') {
          variantSuccessMeans.push(t.aggregate.taskSuccessRate.mean);
        }
      }
      const avg = (xs: readonly number[]): number =>
        xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
      // eslint-disable-next-line no-console
      console.log(
        `[reflexion-cmp] baseline meanTaskSuccessRate=${avg(baselineSuccessMeans).toFixed(
          3,
        )} variant meanTaskSuccessRate=${avg(variantSuccessMeans).toFixed(3)}`,
      );

      // ---- assertion 1: taskSuccessRate has winner-variant; never winner-baseline ----
      const successRows: { fixtureId: string; label: string }[] = [];
      for (const fixture of report.fixtures) {
        const row = fixture.rows.find((r) => r.metric === 'taskSuccessRate');
        if (row) successRows.push({ fixtureId: fixture.fixtureId, label: row.label });
      }
      const winners = successRows.filter((r) => r.label === 'winner-variant').length;
      const losers = successRows.filter((r) => r.label === 'winner-baseline').length;
      expect(losers).toBe(0);
      expect(winners).toBeGreaterThan(0);

      // ---- assertion 2: no truthfulness regression ----
      for (const fixture of report.fixtures) {
        for (const row of fixture.rows) {
          if (row.metric !== 'truthfulnessViolationRate') continue;
          expect(row.label).not.toBe('winner-baseline');
        }
      }
    },
    { timeout: 60_000 },
  );
});
