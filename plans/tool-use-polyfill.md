# Tool-use polyfill for `@inbrowser/agent`

> **Status: SHELVED 2026-05-19.** The probe set was extended to four
> models (added Phi-3 mini, Qwen 3 4B, SmolLM2 360M). The combined
> data showed the polyfill's viable target class is essentially empty
> in practice — models small enough to want polyfilling can't follow
> the protocol, and models large enough to follow it already ship
> with native tool calling. See "Verdict from extended probes" below.
> Plan kept as design-of-record; do not implement without re-running
> the probe set against new candidate models.

Plan written 2026-05-19. Grounded in empirical probes of four models
via Ollama (`/v1/chat/completions`). Don't change the protocol design
without re-running the probe set; model behavior is brittle and
counterintuitive.

## Goal

Wrap any `LlmClient` whose underlying model lacks native tool calling
so it becomes tool-capable from the agent runtime's perspective.
"Native tool calling" means the upstream chat-completion API accepts a
`tools` parameter and emits structured `tool_calls` in responses. Many
small open models don't have this — Gemma 3 (Ollama hard-errors on
`tools`), SmolLM, base Qwen 2.5 in q4 form, DeepSeek R1 distill on
many hosts.

The polyfill works by:

1. Stripping `tools` from the underlying call (so providers that
   reject the parameter don't error).
2. Injecting a system-prompt addendum that describes the tools in
   prose + JSON Schema + envelope-format examples.
3. Streaming the model's text output through a parser that detects
   tool-call envelopes (default `<tool_call name="…">{…json…}</tool_call>`)
   and emits synthetic `tool_call` events.
4. Translating prior assistant `toolCalls` and `tool`-role
   `resultJson` messages back into text envelopes so the model sees
   conversation history in the format it knows.

## Why this lives in `@inbrowser/agent`, not `@inbrowser/model`

The polyfill is a property of the agent runtime, not the engine. Any
`LlmClient` benefits — cloud and local, tools-capable and not.
Putting it in `@inbrowser/agent` means:

- `@inbrowser/model` engines stay narrow (causal-LM with no tool
  vocabulary; same shape as today).
- A future cloud provider that doesn't support tools (some Together
  / Replicate / Groq models) gets lifted by the same wrapper.
- The agent's existing `LlmClient` interface already declares
  `supportsTools: boolean` — wrapping flips it from `false` to `true`
  without any consumer-side awareness.

## Existing types this builds on

Already in `packages/agent/src/types/llm.ts` and `chat.ts`:

```ts
export interface LlmClient {
  readonly id: string;
  readonly supportsTools: boolean;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}

export interface ChatRequest {
  messages: NormalizedMessage[];
  tools: ToolDeclaration[];
  toolUseEnabled: boolean;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export type ChatEvent =
  | { kind: 'text'; chunk: string }
  | { kind: 'thinking'; chunk: string }
  | { kind: 'tool_call'; id: string; name: string; args: unknown; signature?: string }
  | { kind: 'turn_complete'; usage: RawUsage; details: TurnDetails }
  | { kind: 'error'; message: string };

export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text: string;
  toolCalls?: { callId: string; name: string; args: unknown; signature?: string }[];
  callId?: string;
  name?: string;
  resultJson?: string;
}
```

The polyfill produces these same types — no new vocabulary needed.

## Empirical findings

Probed `/v1/chat/completions` against a local Ollama server (v0.20.3)
using four models spanning the relevant size range:

- **SmolLM2 360M** (`smollm2:360m`) — verification canary size
- **Gemma 3 1B** (`gemma3:1b`) — small model, instruction-tuned
- **Phi-3 mini** (`phi3:mini`, 3.8B) — Microsoft, reasoning-tuned
- **Qwen 3 4B** (`qwen3:4b`) — frontier-for-size; also tested native
  tool support via Ollama (passes)

The four responded to identical prompts in **categorically different**
ways. That itself is the headline finding: **prompt template choice
is model-specific, the effect is large, and the viable target size
band for polyfilling is narrow.**

### 1. The hard wall: Ollama refuses `tools` on three of four models

| Model | `tools=` param accepted? |
|---|---|
| `smollm2:360m` | ❌ HTTP 400 |
| `gemma3:1b` | ❌ HTTP 400 |
| `phi3:mini` | ❌ HTTP 400 |
| `qwen3:4b` | ✅ Returns normally; also surfaces `reasoning` field |

The error shape is consistent across the rejecting models:

```json
{"error": {"message": "registry.ollama.ai/library/...:... does not support tools", "type": "invalid_request_error"}}
```

**Design implication:** the polyfill MUST strip `tools` and
`tool_choice` from the request it forwards to the inner client. The
inner `LlmClient.chat()` will see `tools: []` and
`toolUseEnabled: false` regardless of what the outer caller passed.

**But also:** the fact that Qwen 3 4B has native support via Ollama
*and* would be in scope for polyfilling via `@inbrowser/model` (where
our engine doesn't pass tools to Transformers.js) hints at the
shelving rationale — see "Verdict from extended probes" below.

### 2. Prompt-template sensitivity is model-specific *and inverts*

Identical three prompts (weather request, math request, conversational),
two system-prompt variants:

- **Loose:** "To call a tool, emit EXACTLY this format and nothing else:
  `<tool_call name=\"TOOL_NAME\">{\"arg\":\"value\"}</tool_call>`. If no
  tool is needed, answer normally."
- **Tight:** Same plus two concrete JSON examples plus
  "The text inside the tag must be valid JSON. Do not write key=value
  or parenthesised arguments."

#### Gemma 3 1B

| Prompt | Loose prompt | Tight prompt |
|---|---|---|
| Weather | `<tool_call name="get_weather">tokyo</tool_call>` (tag ✅, args ❌) | "I am sorry, I cannot fulfill this request" (refusal) |
| Math | 7 envelopes — multiple `get_weather`, mangled `add` (wrong tool, wrong args) | "28 + 17 = 45" (skipped tool) |
| Search | (not tested) | ` ```json\n{"tool_call": "search(query: 'x')"}\n``` ` (invented format) |

Gemma 3 1B is **better** with the loose prompt — at least it produces
*something* envelope-shaped. The tight prompt makes it refuse or
invent alternatives.

#### Phi-3 mini

| Prompt | Loose prompt | Tight prompt |
|---|---|---|
| Weather | Pre-tag chatter + correct JSON envelope but mangled close tag `</tooltable>` | ✅ Clean: `<tool_call name="get_weather">{"city":"Tokyo"}</tool_call>` |
| Math | "45" (skipped tool) | ✅ Clean: `<tool_call name="add">{"a":17,"b":28}</tool_call>` |
| Conversational ("Hi, what's your name?") | False positive — spurious `<tool_call name="get_weather">{"city":"Paris"}</tool_call>` after the reply | (not tested) |
| Search | (not tested) | Correct envelope, then 200 lines of post-tag chatter inventing fake search results |
| Ambiguous ("Tell me about Paris") | (not tested) | ✅ Plain text, no envelope. Correct |

Phi-3 mini is **better** with the tight prompt — the examples nail the
JSON args. Without them it produces valid-JSON args but corrupts the
close tag and adds chatter around the envelope.

#### Qwen 3 4B (with `tools=` stripped — simulating the polyfill path)

Run with no `tools` parameter to test what happens when the polyfill
wraps it (i.e., when Qwen 3 4B is used through `@inbrowser/model`
where the engine doesn't pass tools to Transformers.js):

| Prompt | Loose prompt | Tight prompt |
|---|---|---|
| Weather | ✅ Clean: `<tool_call name="get_weather">{"city": "Tokyo"}</tool_call>` | ✅ Same |
| Math | ✅ Clean: `<tool_call name="add">{"a":17,"b":28}</tool_call>` | ✅ Same |
| Conversational | ✅ Plain text reply | (not tested) |
| Search | (not tested) | ✅ Clean envelope |
| Ambiguous "Tell me about Paris" | (not tested) | 🟡 Invoked `search` (debatable false positive — model interpreting as a research request) |

Qwen 3 4B is **excellent at both loose and tight** — but the data is
not what you'd expect to act on, because Qwen 3 4B *already has native
tool support* via Ollama. The polyfill would only ever route around
that for one specific case: when the same model is used via
`@inbrowser/model` and the engine isn't yet passing tools through.

#### SmolLM2 360M

| Prompt | Loose prompt | Tight prompt |
|---|---|---|
| Weather | ❌ `get_weather('shun Tokai')` — wrong format (pseudo-call) AND wrong city | ❌ Wrote Python code blocks, fabricated weather JSON inline |
| Math | ❌ "36" (wrong answer, no envelope) | 🟡 Got 45 but in conversational form, no envelope |
| Conversational | ❌ Hallucinated identity ("My name's Alex Green") | (not tested) |
| Search | (not tested) | ❌ Hallucinated WebGPU facts (made up "WebAVX", "WG8 working group", fake URLs) |
| Ambiguous "Tell me about Paris" | (not tested) | 🟡 Plain text but riddled with fabrications ("Guess Harbor", "L'homme Bleu") |

SmolLM2 360M is **categorically unable** to follow a tool-calling
protocol. The model is too small to grasp the instructions —
hallucinates aggressively, invents alternative formats, ignores
system context, and fabricates "results" inline as if it called a
tool itself.

**Implication: same template, opposite outcomes — *and a hard floor*.**
A one-size-fits-all prompt is impossible, AND polyfilling can't
rescue models below ~1B params.

## Verdict from extended probes (the shelving rationale)

Cross-tabulating the four-model data against the polyfill's
hypothetical target — "we want to use this in browser AND it has no
native tool calling AND it's good enough at instruction-following to
be polyfillable" — reveals that the target class is empty in
practice:

| Class | Example | Polyfill works? | Why we wouldn't ship it polyfilled |
|---|---|---|---|
| ≤500M params | SmolLM2 360M | ❌ Categorically fails | Too small to grasp protocol; flaky tool calls are worse than no tool calls |
| 1–2B params, no native | Gemma 3 1B | 🟡 ~40% e2e success | Same reasoning — flaky calls hurt UX; pick a tools-native sibling |
| 3–4B params, no native | Phi-3 mini (q4) | ✅ ~80% with tight prompt | But Phi-3.5 mini *does* have native tools; same architecture, ship the newer model |
| 3–4B+ params, native exists | Qwen 3 4B, Llama 3.2 3B+ | ✅ ~95% | Native works — polyfill is redundant |

The "no native tool calling AND polyfillable" intersection is
populated only by superseded model versions whose successors are
already tool-native. Net target users at time of writing: zero.

**Decision:** shelve. Implement native tool passing in
`@inbrowser/model`'s engine when the preset's `supportsTools: true`
(separate ~1 day of work, in scope for the bundling pivot). Keep
this plan as design-of-record. Revisit if a model materially relevant
to in-browser deployment ships without native tool support.

### 3. Failure-mode catalog (across both models)

| Failure mode | Where observed | Example |
|---|---|---|
| Args malformed (not JSON) | Gemma loose, high | `>tokyo<` instead of `>{"city":"tokyo"}<` |
| Args use `key=value` instead of JSON | Gemma loose | `>city=London<` |
| Multiple tool calls per response | Gemma loose | 7 calls in one math response |
| Wrong tool selected | Gemma loose | `get_weather` invoked for math |
| Alternative envelope formats | Gemma tight | markdown-fenced JSON, `tool(arg)` syntax |
| Refusal to use tools | Gemma tight | "I am sorry, I cannot fulfill this request" |
| Correct answer, tool skipped | Both, varies by prompt | `"45"` instead of `add(17, 28)` |
| Close tag corruption | Phi-3 loose | `</tooltable>` instead of `</tool_call>` |
| Pre-tag chatter | Phi-3 loose | "To find out about the climate... let me call..." then the envelope |
| Post-tag chatter (inventing tool results) | Phi-3 tight | Envelope followed by fabricated JSON result blocks |
| Spurious tool call (false positive) | Phi-3 loose | Random `get_weather` call appended to a conversational reply |

The polyfill design has to be robust to all of these, not just the
happy path. We do **not** assume the model will reliably emit
well-formed JSON in well-formed tags. We assume it will produce
mostly-shaped output that the parser must interpret charitably and
that downstream layers may need to retry against.

### 4. Design implications, locked in by data

- **System prompt is a tuning surface per model family**, not a fixed
  string. `buildSystemPrompt(tools)` opt is the right surface.
- **Ship sensible defaults *per family*** (Gemma-style loose, Phi-style
  tight, etc.), not a global default. Identify the family from the
  model id when possible.
- **Parser must tolerate pre- and post-tag chatter** — Phi-3 puts
  chatter on either side of valid envelopes routinely.
- **Parser must tolerate corrupted close tags** — `</tooltable>` is a
  real observation; the parser should treat any matching string of
  `</tool_*>` or even fall back to "first `</` after open tag" as a
  close marker for `xml-tags`. Conservative but pragmatic.
- **Cardinality must support 0..N tool calls per response** —
  conversational responses produce 0, math under Gemma loose produced 7.
- **An eval harness is non-negotiable** — without measurement, prompt
  tweaks regress invisibly. Phi-3's behavior under loose vs. tight
  diverges sharply with no warning signs.

## Public surface

```ts
// packages/agent/src/tool-polyfill/index.ts
export function withToolUsePolyfill(
  inner: LlmClient,
  opts?: ToolUsePolyfillOpts,
): LlmClient;

export interface ToolUsePolyfillOpts {
  /**
   * Envelope format the system prompt asks the model to emit. Default
   * is `'xml-tags'` based on the Gemma 3 1B probe set — it was the
   * format the model adhered to most often under a *loose* prompt.
   *
   * The parser ALWAYS accepts all formats regardless of which one
   * the prompt requests, because models routinely invent alternatives
   * (see empirical findings).
   */
  envelopeFormat?: 'xml-tags' | 'json-fence';

  /**
   * Strategy when the model returns text that contains no
   * recognizable envelope despite tools being available.
   *
   *   - 'allow' (default): the response is forwarded as-is; the model
   *     just chose not to use a tool. Common and legitimate.
   *   - 'retry': append a corrective user message ("please use one of
   *     the available tools") and call the inner client again, up to
   *     `maxRetries` times. Useful when the runtime *requires* a
   *     tool call (e.g., the planner.
   */
  noToolStrategy?: 'allow' | 'retry';

  /**
   * Strategy when the model emits an envelope but the args don't
   * parse as JSON OR don't match the tool's parameter schema.
   *
   *   - 'best-effort' (default): apply lightweight coercion
   *     (key=value parsing, single-arg lifting), and if still bad,
   *     emit a synthetic error event in-stream and continue.
   *   - 'retry': append a corrective message and re-call.
   *   - 'reject': emit `error` and stop.
   */
  malformedArgsStrategy?: 'best-effort' | 'retry' | 'reject';

  /**
   * Cap on retry attempts when noToolStrategy/malformedArgsStrategy
   * is 'retry'. Default 1.
   */
  maxRetries?: number;

  /**
   * Override the system-prompt template builder. The default is
   * tuned for the Gemma family per the empirical findings; consumers
   * with different models can plug in their own. Receives the
   * declared tools, returns the addendum string.
   */
  buildSystemPrompt?: (tools: ReadonlyArray<ToolDeclaration>) => string;
}
```

Wrapping is the only consumer-side change:

```ts
import { withToolUsePolyfill } from '@inbrowser/agent';
import { gemma3OnnxClient } from '…';   // or any LlmClient

const client = withToolUsePolyfill(gemma3OnnxClient);
// client.supportsTools === true now
```

## Internal architecture

```
packages/agent/src/tool-polyfill/
  index.ts             public exports
  types.ts             ToolUsePolyfillOpts (above)
  with-polyfill.ts     withToolUsePolyfill — main wrapper
  prompt.ts            system-prompt builders (one per envelope format,
                       plus the model-tuned defaults)
  encode-history.ts    convert prior NormalizedMessage[].toolCalls /
                       resultJson into text envelopes the model
                       expects in the conversation
  parse-stream.ts      parse a ChatEvent.text stream and emit
                       synthetic tool_call events
  validate.ts          coerce args (key=value -> JSON), validate
                       against tool's JsonSchema, decide retry/reject
```

### Parsing strategy

Built on the same approach as `splitThinking` in
`@inbrowser/model/think.ts` — buffer-aware state machine that
tolerates tags split across chunk boundaries.

Two envelope formats accepted **at parse time** regardless of which
one the prompt requested (because real models reinvent):

1. **XML tags** (`<tool_call name="X">{…}</tool_call>`) — the system
   prompt's preferred format.
2. **Fenced JSON** (` ```json\n{"tool":"X","args":{…}}\n``` `) — a
   format models drift into; cheap to also accept.

Parser state machine:

- `normal` — passing tokens through as `text` ChatEvents.
- `inside-xml` — buffering content between `<tool_call …>` and
  `</tool_call>`.
- `inside-fence-pre` — saw ```` ```json ````, looking for the closing
  fence.
- On close, parse the buffered content via `validate.ts` and emit
  either `tool_call` or `error`.

### Argument coercion ladder

Observed Gemma 3 1B args by frequency (loose prompt):

| Form | Coercion |
|---|---|
| Valid JSON object | use as-is |
| `key=value` or `key: value` lines | parse as a flat object, coerce numbers/booleans by JSON.parse-attempt |
| Single bare value matching a single-param tool | wrap as `{ [paramName]: value }` |
| Pseudo-call syntax (`add(17 + 28)`, `search(query: 'x')`) | regex extract name, treat args as malformed |
| Other | reject |

If coercion fails AND `malformedArgsStrategy === 'best-effort'`, emit
`{kind: 'error', message: 'tool_call args could not be parsed: …'}`
inline and continue. The agent runtime decides whether to surface it
or retry at a higher level.

### History encoding

When the wrapper receives `messages: NormalizedMessage[]` with
historical tool turns (assistant.toolCalls + tool.resultJson), it has
to project them into a format the no-tools model has seen before. The
encoder transforms:

```ts
// Before (real history with native tool surface)
{role: 'assistant', text: '', toolCalls: [{callId: 'c1', name: 'add', args: {a:3,b:4}}]}
{role: 'tool', callId: 'c1', name: 'add', resultJson: '7'}

// After (text envelopes the no-tools model recognizes)
{role: 'assistant', text: '<tool_call name="add">{"a":3,"b":4}</tool_call>'}
{role: 'user', text: '<tool_result name="add">7</tool_result>'}
```

Choice of `'user'` role for tool results (rather than `'system'` or a
made-up `'tool'`) is empirically driven: Ollama OAI compat enforces
the canonical role set, and inserting a `user`-role message with a
clear envelope is the cleanest way to make the model "see" the result
in its conversation history without role-confusion.

## Empirical iteration loop (mandatory)

Prompt phrasing decisions must be validated by re-running the eval
set before merging. The methodology:

### Fixture

`packages/agent/test/fixtures/tool-polyfill-eval.json` —
N prompts × labeled expected behavior:

```jsonc
{
  "prompts": [
    {
      "user": "What is the weather in Tokyo?",
      "expect": { "tool": "get_weather", "args": {"city": "Tokyo"} }
    },
    {
      "user": "What is 17 plus 28?",
      "expect": { "tool": "add", "args": {"a": 17, "b": 28} }
    },
    {
      "user": "Hi, what's your name?",
      "expect": { "tool": null }
    },
    // … 20 total: 5 per tool + 5 conversational
  ],
  "tools": [
    { "name": "get_weather", "description": "…",
      "parameters": { "type": "object", "properties": { "city": { "type": "string" } },
                      "required": ["city"] } },
    { "name": "add", "description": "…", "parameters": { … } },
    { "name": "search", "description": "…", "parameters": { … } }
  ]
}
```

### Metrics

Per prompt:

- **Envelope detected**: yes/no
- **Tool name in registry**: yes/no
- **Args parseable** (post-coercion): yes/no
- **Args schema-valid**: yes/no
- **Right tool selected**: yes/no (only when expect.tool !== null)
- **Correctly skipped tool**: yes/no (only when expect.tool === null)

Aggregate:

- **Format adherence rate** — % of prompts where parser found an envelope (when one was expected)
- **End-to-end success rate** — % where the parsed call matched expectations
- **False-positive rate** — % of conversational prompts that wrongly triggered a tool

Targets, per model family, before merge:

| Model class | Format adherence | End-to-end success | False-positive rate |
|---|---|---|---|
| Gemma 3 1B (loose prompt) | ≥80% | ≥40% | ≤30% |
| Phi-3 mini (tight prompt) | ≥90% | ≥70% | ≤15% |
| Qwen 3 4B (TBD, expect tight) | ≥90% | ≥75% | ≤15% |
| Llama 3.2 3B (TBD) | ≥85% | ≥65% | ≤20% |

The Gemma 3 1B targets are weaker on purpose — its loose prompt
produces noisy args that the coercion ladder partially salvages, but
not all the time. We commit to "polyfill works on this model" at
those numbers; consumers wanting higher quality should pick a bigger
model.

Phi-3 mini is the *first model whose tight-prompt numbers we'd ship
with* — the math and weather probes were essentially perfect once the
prompt included concrete JSON examples.

### Runner

`packages/agent/test/tool-polyfill.integration.test.ts` — drives the
wrapped client against the fixture against a local Ollama at
`OLLAMA_BASE_URL` (default `http://localhost:11434`). Skipped under
CI unless `OLLAMA_BASE_URL` is set, since CI typically doesn't have
Ollama running.

## Implementation phases

| Phase | Scope | Verifiable by |
|---|---|---|
| 1 | Surface + types + system-prompt builder + history encoder + unit tests against a mock `LlmClient` | `bun run --cwd packages/agent test` |
| 2 | Stream parser (XML + fenced JSON) + arg coercion ladder + unit tests | Same |
| 3 | `withToolUsePolyfill` wires it together; integration test against real Gemma 3 1B via Ollama | `OLLAMA_BASE_URL=… bun test` |
| 4 | Iterate prompt templates against the eval set until targets met | Eval report committed alongside |
| 5 | Wire into `@inbrowser/model`'s `agent` adapter — when `engine.capabilities.supportsTools === false`, the adapter wraps with the polyfill automatically | End-to-end against a real `@inbrowser/model` engine + the example app |

## Open questions, all to be answered empirically

1. **Streaming vs buffer-and-finalize.** Should `text` events stream
   through while we wait to confirm an envelope, or should the parser
   buffer the entire response and emit events post-hoc? Streaming
   feels right, but Gemma 3 1B's tendency to start with an envelope
   and then NOT actually invoke a tool (instead just continuing as
   text) means we'd be re-classifying mid-stream. Decide after
   measuring how often this happens.

2. **Multiple tool calls per response.** Gemma emitted 7 envelopes in
   one math response. Should we forward all, just the first, or only
   those that schema-validate? The agent runtime today executes tool
   calls in declared order; emitting all gives it the choice.

3. **Tag literal customization.** Some models do better with
   `<function_call>` or `<call>` than `<tool_call>`. Worth A/B
   testing under phase 4. If significant, expose `openTag` /
   `closeTag` on `ToolUsePolyfillOpts`.

4. **Retry corrective-prompt wording.** Open until phase 4.
   Likely candidates: "Your previous response was not a valid tool
   call. Re-emit it as …" vs "I couldn't parse that. Please try
   again." Tone matters with small models.

5. **JSON Schema validation library.** Plain runtime validation —
   `ajv` is the standard but adds 100 KB. Alternatives: a tiny
   hand-rolled validator for the schema subset we use, or just
   `JSON.parse` + type-check `typeof`. Decide after measuring how
   complex tool schemas get in real usage.

## Files touched (estimate)

| File | Status |
|---|---|
| `packages/agent/src/tool-polyfill/index.ts` | new |
| `packages/agent/src/tool-polyfill/types.ts` | new |
| `packages/agent/src/tool-polyfill/with-polyfill.ts` | new |
| `packages/agent/src/tool-polyfill/prompt.ts` | new |
| `packages/agent/src/tool-polyfill/parse-stream.ts` | new |
| `packages/agent/src/tool-polyfill/encode-history.ts` | new |
| `packages/agent/src/tool-polyfill/validate.ts` | new |
| `packages/agent/src/index.ts` | re-export |
| `packages/agent/test/tool-polyfill.test.ts` | new — unit (mocked) |
| `packages/agent/test/tool-polyfill.integration.test.ts` | new — vs Gemma 3 1B |
| `packages/agent/test/fixtures/tool-polyfill-eval.json` | new |
| `packages/model/src/adapters/agent.ts` | auto-wrap on `supportsTools: false` |

About 12 files. Implementation should land across 4–5 commits per
phase boundary.

## Risk register

| Risk | Mitigation |
|---|---|
| Gemma 3 1B is too small to reliably envelope; bigger models work better but we can't headless-verify them | Eval against 3 sizes (Gemma 3 1B, Llama 3.2 3B, Qwen 3 4B) before merge. Document per-model success rates in the README. |
| Prompt template needs different phrasing per model family | `buildSystemPrompt` option already exposed; ship sensible defaults for the families we test |
| Parser drifts as new envelope formats appear in the wild | The parser's "accept anything that looks tool-call-shaped" stance bounds the damage. Add new formats to `parse-stream.ts` as we see them; no API churn |
| Ollama-server-requiring tests fail in CI | Gate integration tests on `OLLAMA_BASE_URL` env var; skip cleanly when unset |
| `@inbrowser/model` auto-wrap (phase 5) accidentally degrades models that *do* tool-call eventually (Qwen 3 1.7B has tool slots in template) | The polyfill is opt-in via `withToolUsePolyfill`; auto-wrap in the adapter is gated on `engine.capabilities.supportsTools === false`, which is preset-declared. If a preset's capability is wrong, the user can opt out by spreading the unwrapped engine into their own `LlmClient` construction. |
