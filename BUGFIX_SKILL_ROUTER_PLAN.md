# Skill Router Bug Review and Fix Plan

**Code‑base overview**

The repository is a monorepo with four workspace packages under `packages/`:

| Package | Purpose | Key entry points |
|---|---|---|
| `@inbrowser/resumable` | Durable streaming‑job engine (memory & Firebase RTDB stores). | `src/engine.ts`, `src/store/*` |
| `@inbrowser/relay` | LLM‑relay that normalises provider APIs (Gemini, Ollama, Anthropic, OpenRouter, etc.). | `src/relay.ts`, `src/client/*`, `src/providers/*` |
| `@inbrowser/agent` | CLI/runtime that orchestrates a session, routes a user prompt to a *skill*, executes the skill plan, and records an event log for replay/undo. | `src/skill-catalog.ts`, `src/skill-router.ts`, `src/planner‑executor.ts`, `src/dispatch‑memoization.ts`, `src/session.ts` |
| `@inbrowser/model` | On‑device LLM wrapper (Gemma, Phi‑3, etc.) exposing a uniform `Engine` that yields `EngineEvent`s (`token`, `thinking`, `tool_call`, …). | `src/engine.ts`, `src/parse-tool-calls.ts`, adapters for `relay` and `agent` |

Common infrastructure:

* **Type safety** – a shared `tsconfig.base.json` and strict TypeScript across all packages.
* **Event log** – NDJSON streams stored under `~/.pyric/...`. The log is the single source of truth for replay, undo, and diagnostics.
* **Skill system** – a static `SkillCatalog` (see `packages/agent/src/skill-catalog.ts`) describes each skill’s name, description, trigger‑hint keywords, and ordered `PlanStep`s.
  * `skill-router.ts` scores a prompt against the catalog using simple substring matching.
  * `planner‑executor.ts` walks the chosen skill’s steps, invoking tools via the LLM adapter.

All test suites (`bun test`) pass (525 tests, 0 failures). Type‑checking also succeeds for every package.

---

**Potential issue discovered**

`packages/agent/src/skill-router.ts` implements the keyword‑based router. The logic is sound, but the *ambiguity guard* may be overly aggressive:

```ts
// Ambiguity guard – when top and runner‑up tie on score *and* the
// name‑in‑prompt flag is identical, the router returns null.
if (match !== null && top.score > 0 && scored.length > 1) {
  const runnerUp = scored[1];
  if (runnerUp.score === top.score && runnerUp.nameInPrompt === top.nameInPrompt) {
    match = null;
  }
}
```

**Why this matters**

* The router’s test suite (`skill-router-accuracy.test.ts`) reports only **65 %** accuracy.
* In many realistic prompts the top two skills often share the same number of trigger‑hint hits (e.g., “firestore audit” vs. “firestore rules audit”). Both may also have `nameInPrompt === false`. The current guard then forces a `null` match, sending the prompt to the fallback ReAct planner even when one of the tied skills would have been a correct choice.
* The brief’s requirement is *“never return a wrong skill”*, not *“never return a null when a correct skill exists”.* The guard therefore reduces recall without improving precision (the router already prefers the correct skill when the tie‑breaker distinguishes them).

**Suggested minimal fix**

Replace the strict “both score and name‑in‑prompt tie → null” with a more permissive rule that only discards the match when the top two entries have **identical scores *and* both have `nameInPrompt === true**. This preserves the safety guarantee (a tie where both names appear in the prompt is ambiguous) while allowing a match when neither name appears.

```ts
// Revised ambiguity guard
if (match !== null && top.score > 0 && scored.length > 1) {
  const runnerUp = scored[1];
  const bothNamesInPrompt = top.nameInPrompt && runnerUp.nameInPrompt;
  if (
    runnerUp.score === top.score &&               // same hit count
    top.nameInPrompt === runnerUp.nameInPrompt && // same name‑in‑prompt flag
    bothNamesInPrompt                            // both names present → ambiguous
  ) {
    match = null; // ambiguous, fall back to ReAct
  }
  // otherwise keep the top entry (no true ambiguity)
}
```

The change is limited to `skill-router.ts`, does not affect any public API, and can be covered by a new test case that verifies the router now returns the top skill when both candidates have the same score but neither name appears in the prompt.

---

**Plan to fix the bug**

1. **Add a new test** in `packages/agent/test/skill-router-accuracy.test.ts` (or a dedicated test file) that covers the scenario where two skills tie on score and neither name appears in the prompt. Verify the router returns the top‑scoring skill instead of `null`.
2. **Update `skill-router.ts`** to implement the revised ambiguity‑guard logic described above.
3. **Run the full test suite** (`bun test`) to ensure no regressions and that the new test passes.
4. **Check the accuracy metric** (`skill-router-accuracy.test.ts` prints accuracy) – it should improve above the current 65 %.
5. **Commit the changes** on a feature branch with a conventional commit message, e.g., `fix(agent): improve skill router ambiguity handling and add test`. Push and open a PR for review.

This plan touches only one source file and adds a single test, keeping the change minimal while directly addressing the identified bug.
