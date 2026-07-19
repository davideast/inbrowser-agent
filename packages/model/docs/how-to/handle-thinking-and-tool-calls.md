# How To Handle Thinking And Tool Calls

Separate a model's reasoning trace and its tool-call envelopes out of the raw token stream, so you can route them to different surfaces.

The engine speaks a narrow [`EngineEvent`](../reference/engine.md) vocabulary: it emits decoded text as `token` events and never classifies reasoning or tool calls on its own. Two stream transformers, both exported from `@inbrowser/model/local`, do that classification by wrapping the engine's generator.

## Split Out Thinking

`splitThinking(source, opts?)` re-emits the stream unchanged, except text inside the reasoning tags becomes `kind: 'thinking'` instead of `kind: 'token'`. The default tags are `<think>` and `</think>`.

```ts
import { splitThinking } from '@inbrowser/model/local';

for await (const evt of splitThinking(engine.generate(messages))) {
  if (evt.kind === 'thinking') showReasoning(evt.text);
  else if (evt.kind === 'token') showOutput(evt.text);
}
```

If your model uses different tags, pass `openTag` and `closeTag`. The cleanest path is to read them off the preset so your consumer stays model-agnostic:

```ts
import { deepseek_r1_qwen_1_5b } from '@inbrowser/model/local';

const tags = deepseek_r1_qwen_1_5b.capabilities.thinkingTags;
for await (const evt of splitThinking(engine.generate(messages), tags)) {
  // ...
}
```

If the model begins generating *inside* the thinking channel (its chat template pre-fills the open marker), set `implicitOpen: true` so the first close tag ends the block. If structural tokens leak into the output, pass `stripTokens` to remove those literal substrings from `token` events.

`usage` and `error` events pass through unchanged, so terminal accounting is preserved.

## Parse Tool Calls

`parseToolCalls(source, opts?)` detects `<tool_call>{ ... }</tool_call>` envelopes and emits one `kind: 'tool_call'` event per envelope, with `id`, `name`, and `args`.

```ts
import { parseToolCalls } from '@inbrowser/model/local';

for await (const evt of parseToolCalls(engine.generate(messages))) {
  if (evt.kind === 'tool_call') dispatchTool(evt.name, evt.args);
  else if (evt.kind === 'token') showOutput(evt.text);
}
```

The envelope body is parsed as JSON to extract `name` and `arguments`. On a parse failure, `args` carries `{ _raw: string }` so you can salvage or surface the malformed call rather than lose it. The `id` is generated locally, since the model does not supply one.

## Compose Both

The transformers share the same shape, so wrap one in the other around a single `engine.generate()` call:

```ts
import { splitThinking, parseToolCalls } from '@inbrowser/model/local';

for await (const evt of parseToolCalls(splitThinking(engine.generate(messages)))) {
  switch (evt.kind) {
    case 'thinking':
      showReasoning(evt.text);
      break;
    case 'tool_call':
      dispatchTool(evt.name, evt.args);
      break;
    case 'token':
      showOutput(evt.text);
      break;
  }
}
```

## Match The Transformer To The Model

Native tool calling only works for tools-capable presets (`qwen2_5_coder_1_5b`, `qwen3_1_7b`), which emit `<tool_call>` envelopes that `parseToolCalls` recognises. Gemma 4 is **not** tool-native; its tool support is a prompt-engineered polyfill that lives in `@inbrowser/agent`, not in these transformers. See [how to choose a preset](./choose-a-preset.md) for which presets do what.

Gemma 4 deliberately omits `thinkingTags`, because its reasoning output is too inconsistent for a text parser to split reliably. Running `splitThinking` over Gemma 4 with default tags is effectively a no-op: its reasoning streams inline as `token` events, which is the intended behaviour for that family.

For the exact `EngineEvent` shapes and the full `ThinkingSplitOpts` and `ToolCallParseOpts` option sets, see [the engine reference](../reference/engine.md). For why the engine stays narrow and pushes classification to wrappers, see [the design notes](../explanation/design.md) and the [on-device inference notes](../explanation/on-device-inference.md).
