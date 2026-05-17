# Generative golden-task fixtures

This directory holds the golden-task fixtures for the four generative
skills exercised by the eval harness. Sibling to
`packages/agent/fixtures/diagnostic/`.

## Layout

```
generative/
  pyric-agents/
    <case-name>.fixture.json
  playground-prompts/
    <case-name>.fixture.json
  rtdb-game-rules/
    <case-name>.fixture.json
  firestore-game-rules/
    <case-name>.fixture.json
```

One subdirectory per skill. The skill name in the directory matches the
`SkillName` literal in `packages/agent/src/eval/fixture.ts` and the
fixture's own `skill` field. File names use kebab-case and end in
`.fixture.json` so the `loadFixtures` helper in `@inbrowser/agent/node`
picks them up.

The case-name does not embed the skill — the directory does that. So
`tic-tac-toe-turn-enforcement.fixture.json` sits under `rtdb-game-rules/`
and its `id` is `rtdb-game-rules/tic-tac-toe-turn-enforcement`.

## What makes a generative fixture

Generative skills are skills whose definition of done is the agent
producing something the runtime can check. Each fixture therefore
contains:

- `id` — `<skill>/<case-name>` kebab-case. Must match the parent
  directory's skill.
- `skill` — one of the four generative skills.
- `description` — one-line summary shown in comparison reports.
- `notes` — optional prose explaining what the fixture exercises and
  any spec-framework fallback choices.
- `prompt` — the user prompt, verbatim.
- `initialState` — seeded workspace fields (`rules`, `code`,
  `appSource`, `presetId`, `stitch`). Seeds are synthetic and inline.
- `successSpec` — a reference to a registered spec by name plus
  optional `args`.

## Coverage

| Skill | Fixtures |
|---|---|
| `pyric-agents` | 3 |
| `playground-prompts` | 2 |
| `rtdb-game-rules` | 3 (tic-tac-toe, lobby, connect-four) |
| `firestore-game-rules` | 3 (tic-tac-toe, connect-four, lobby) |

For each game-rules fixture the success criterion is the simulator
accepting a positive move AND rejecting a defined cheating attempt —
this is the verification the underlying skills themselves name as
their definition of done.

## Spec names

Most fixtures reference one of the starter specs documented in
`.coordination/plans/kickoff-eval-success-spec-framework.md`:

- `report-mentions/at-least-one-of`
- `report-mentions/all-of`
- `trace-contains-tool-call/by-name`
- `final-rules-includes/literal`
- `final-rules-excludes/literal`
- `final-runtime/run-summary-ok`

Two custom spec names appear in this directory and have been flagged
in the branch status file for the `eval/success-spec-framework`
owner:

- `game-rules/simulator-accepts-positive-and-rejects-cheat` — exercises
  both a positive move and a cheating attempt under the simulator.
- `pyric-agents/lint-clean-and-rule-rejects-cheat` — combines lint
  output and a simulator-backed cheating attempt against the resulting
  rules.

If either spec is unavailable when this fixture set runs, the fixture
falls back to the starter spec listed in its `notes` field and the
weaker check is recorded.

## Adding a fixture

1. Pick the skill and drop a file at
   `generative/<skill>/<case-name>.fixture.json`.
2. Set `id` to `<skill>/<case-name>` to match.
3. Seed `initialState` with the smallest, most intentional state that
   reproduces the scenario. Do not reference external files.
4. Reference a starter spec when at all possible. If a custom spec is
   unavoidable, add a row to the branch's status file's open-questions
   list so the spec-framework owner can pick it up.
5. Keep prompts and seeded state model-agnostic. No model provider
   name appears in fixture content.

## Loading

```
import { loadFixtures } from '@inbrowser/agent/node';

const ticTacToeFixtures = loadFixtures(
  'packages/agent/fixtures/generative/rtdb-game-rules',
);
```

The loader is non-recursive — it reads one directory at a time. The
smoke test at `packages/agent/test/eval/golden-tasks-generative.test.ts`
walks every subdirectory and asserts the total count.
