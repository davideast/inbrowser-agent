# Why The Engine Is Shaped This Way

`@inbrowser/model` runs an LLM in the browser and exposes it behind a small
`Engine` surface. The surface is small on purpose. This page explains the
load-bearing decisions behind that shape and the trade-offs each one accepts.

For the exact configuration objects and event variants named below, see
[the engine reference](../reference/engine.md).

## One Factory, Many Presets

There is exactly one way to construct an engine: `createEngine(preset)`. New
models do not get new factory functions. There is no `createGemmaEngine`, no
`createQwenEngine`. A new model is a new `ModelPreset` value, and a preset is
plain data: a locator, a `dtype`, a backend, and a capability declaration.

The alternative, a factory per model family, looks convenient at first and
ages badly. Every factory is a place where load logic, decode logic, and
event translation can quietly diverge. Two factories that were meant to behave
identically drift the moment one of them gets a bug fix the other doesn't. By
collapsing construction into a single function, the runtime behaviour lives in
one place and the *differences between models* live in data.

This also changes who can add a model. Because a preset is data authored
through `definePreset`, a community model is a new exported constant, not a
patch to the engine. The cost is that the engine must be general enough to
drive every preset through the same code path, but for transformer decode loops
that generality is largely free; the model card varies, the loop does not.

## Capabilities Live On The Preset, Not The Engine

A model's capabilities, context window, tool support, vision, audio, whether
it emits thinking traces, are declared on the `ModelPreset`, statically,
before anything loads.

This matters because loading is expensive. A preset may pull hundreds of
megabytes to gigabytes of weights over the network. If you could only learn a
model's context window *after* paying that cost, every capability check would
be gated behind a download. Putting capabilities on the preset makes them
interrogable up front: `gemma4_E2B.capabilities.contextWindow` is a property
read on a constant, answerable while the user is still deciding whether to load
at all.

That enables the decisions that should happen *before* the download: routing a
request to a model that supports tools, refusing to offer image upload for a
text-only preset, sizing a context budget. The runtime `Engine` still exposes
the same `capabilities`, and confirms them after load, but the authoritative,
free-to-read copy is the static one.

The honest trade-off is that a static declaration can be wrong. The preset
claims what the upstream model card claims; if an ONNX export silently drops a
capability, the declaration over-promises. The presets handle this by being
conservative: several models that *could* call tools declare
`supportsTools: false` because their export dropped the tool-trained head. A
capability you can read for free is only useful if it is honest, so the presets
err toward under-claiming.

## EngineEvent Is Deliberately Narrow

The engine emits a small event vocabulary: tokens, thinking, tool calls, a
terminal usage record, and errors. That is the whole language. Notably absent
are cloud-shaped concepts: there is no per-token cost, no provider-specific
`thoughtSignature`, no opaque vendor extension fields.

That absence is the point. Cost is a billing concept that has no meaning when
the weights run on the user's own GPU. A thought signature is an artefact of a
specific hosted API's resumption protocol. If the engine's event type carried
those fields, every on-device consumer would handle ideas that never apply to
on-device inference, and the type would grow each time some upstream API
invented a new field.

The wider shape that consumers actually want is the stack's one
`ModelClient` contract and its `ModelEvent` — owned by this same package
(`@inbrowser/model/contract`) and implemented directly by the cloud providers.
The engine deliberately does *not* implement that contract itself; the
intended bridge is a single boundary, the planned `createEngineModelClient`
wrapper, that widens `EngineEvent` into `ModelEvent` once. (The earlier
per-consumer adapters — one widening to the relay, one to the agent — have been
removed in favour of that single contract.) Widening at one boundary, rather
than fattening the core, keeps a clean division of labour: the engine knows
about decoding, the wrapper knows about the contract its consumers speak. A
cloud-only field like cost lives on `ModelUsage`, not on the `EngineEvent` type
every on-device consumer imports.

The cost of a narrow core is real: a consumer who wants a richer event must go
through an adapter rather than reading it straight off the engine. That is the
trade being made on purpose. A narrow type that two adapters widen is easier to
keep correct than a union that accumulates every consumer's fields, because the
core only ever changes when *decoding* changes, not when some downstream
protocol does.

## Worker Transparency

The worker subpath hosts an engine inside a Web Worker and connects to it from
the main thread. The connecting call, `connectWorkerEngine()`, returns a value
that satisfies the same `Engine` interface as `createEngine()`. Same methods,
same events, same capability shape.

The symmetry is what makes the worker useful. Decode is CPU- and GPU-heavy; run
it on the main thread and the UI stutters while tokens stream. The obvious fix
is a worker, but if talking to a worker engine looked different from talking
to a direct one, that choice would leak into every consumer. Adapters, the
agent runtime, and UI code would all need a main-thread branch and a
worker branch.

Because the shapes are identical, none of them can tell the difference. The
agent runtime holds an `Engine`; whether that engine decodes in this thread or
across a `postMessage` boundary is invisible to it. Where to run the model
becomes a deployment decision made at one call site, not an architectural fork
that propagates through the codebase. The price is a serialisation boundary:
messages and events cross the worker channel as structured-clone frames, but
that cost is paid inside the transport, behind the same interface, so it never
becomes the consumer's problem.

## Tool Calling Is Agent-Side

The engine is toolless. An `EngineMessage` has no tool fields. There is no tool
registry, no dispatch loop, no execution.

What the engine *does* know is narrow and mechanical. A tools-capable preset
(the Qwen family) is trained to emit native tool-call envelopes, and when such
a preset is active the engine threads the tool declarations through the
tokenizer's chat template and runs the output through `parseToolCalls`, which
surfaces those envelopes as `tool_call` events. That is recognition, not
orchestration; the engine spots the shape the model already emits and names
it.

The harder, more opinionated work is deliberately upstream. Models without
native tool support, Gemma 4 among them, can still be coaxed into calling
tools through prompt engineering and structured-output parsing. That polyfill lives in
`@inbrowser/agent`, not here. It belongs there because it is a *strategy*, not
a fact about the model: which prompt convinces a model to emit a tool call,
how to recover a malformed one, how to feed results back. Those decisions
change as prompting technique evolves, and they should not drag the engine
along with them.

Keeping the engine toolless draws a clean line. The engine decodes tokens and
recognises envelopes the model natively produces. Everything about *making*
a non-tool model behave like a tool model is policy, and policy lives with the
agent. The engine stays a decode loop; the cleverness stays where it can
change without touching it.
