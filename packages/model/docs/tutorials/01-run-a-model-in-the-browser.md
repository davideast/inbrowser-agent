# Tutorial: Run A Model In The Browser

In this tutorial we will load a small language model into a browser tab and
stream its reply, token by token, into the page. No server, no API key, and no
cloud inference. The model runs entirely on the user's device.

We will use `smollm2_360m`, a 360M-parameter model that downloads in roughly
180 MB and runs on the WASM backend when no GPU is present. It is small enough
that this tutorial is reproducible on almost any machine, including headless
ones.

By the end you will have a page that:

1. creates an engine from a preset,
2. shows real download and compile progress while the model loads,
3. streams a generated reply into the page, and
4. prints the final token-usage line.

A complete, working version of everything here lives in
`examples/local-llm-poc`. If you get stuck, that example is the reference.

## Before You Start

This is browser code, not Node code. The engine uses WebGPU or WebAssembly,
which only exist in a browser. You will run it through a bundler and dev
server. This tutorial uses Vite, the same setup the example uses.

We will assume you have a project with `@inbrowser/model` and
`@huggingface/transformers` installed, and a dev server that serves an
`index.html` with a module script. The example's `package.json` and
`vite.config.ts` are a known-good starting point.

## 1. Install The Package

Add the engine and its inference runtime to your project:

```sh
npm install @inbrowser/model @huggingface/transformers
```

`@huggingface/transformers` is a peer dependency: it is the runtime that
actually fetches weights and runs the forward pass. The engine wraps it behind
a narrow surface you will use directly.

## 2. Add A Place To Show Output

We need somewhere to print progress and tokens. Add this to your `index.html`
body:

```html
<button id="generate">Load + generate</button>
<div id="status">idle</div>
<pre id="output"></pre>
<div id="usage"></div>

<script type="module" src="/src/main.ts"></script>
```

The `#status` element will show load progress, `#output` will fill with tokens
as they decode, and `#usage` will hold the final accounting line.

## 3. Create The Engine

Create `src/main.ts`. First, import the factory and the preset:

```ts
import { createEngine, smollm2_360m } from '@inbrowser/model';

const statusEl = document.getElementById('status') as HTMLDivElement;
const outputEl = document.getElementById('output') as HTMLPreElement;
const usageEl = document.getElementById('usage') as HTMLDivElement;
const buttonEl = document.getElementById('generate') as HTMLButtonElement;

const engine = createEngine(smollm2_360m);
```

`createEngine` takes a preset and returns an `Engine`. A preset is plain data:
a model locator plus its dtype, backend, and capabilities. The
`smollm2_360m` preset declares `backend: 'auto'`, which probes for WebGPU and
falls back to WASM. Nothing has loaded yet. The engine is `idle` until you ask
it to load.

## 4. Watch The Load Progress

Loading a model is the one slow step in this tutorial, so we will make it
visible before we trigger it. Subscribe to the engine's lifecycle events:

```ts
engine.on('state', (state) => {
  console.log('state:', state);
});

engine.on('load', (progress) => {
  if (progress.phase === 'fetch') {
    if (progress.totalBytes > 0) {
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
      statusEl.textContent =
        `fetching ${progress.file}: ${mb(progress.loadedBytes)} / ${mb(progress.totalBytes)} MB`;
    } else {
      statusEl.textContent = `fetching ${progress.file}`;
    }
  } else if (progress.phase === 'init') {
    statusEl.textContent = `compiling for ${progress.backend}`;
  } else if (progress.phase === 'ready') {
    statusEl.textContent = 'ready';
  }
});
```

`on('state', ...)` receives the engine's state as it moves from `idle` to
`loading` to `ready`. `on('load', ...)` receives granular `LoadProgress`. The
`fetch` phase carries byte counts as weights stream from the Hugging Face Hub.
The `init` phase fires while the runtime compiles the model graph for your
backend. The `ready` phase means you can generate.

## 5. Load The Model On Click

We will load on a click rather than on page load. Weights are large, so the
user should opt in. Wire the button:

```ts
buttonEl.addEventListener('click', async () => {
  buttonEl.disabled = true;

  await engine.ensureReady();

  // ... generate, added in the next step
});
```

`ensureReady()` performs the load: it fetches the weights and compiles the
graph. The first time it runs, it downloads roughly 180 MB from the Hugging
Face Hub and compiles for your backend. This is slow, and it is the only slow
step. The weights land in the browser's Cache API, so on later page loads the
fetch phase is near-instant and only the compile step runs.

`ensureReady()` is idempotent. Calling it again once the engine is `ready`
returns immediately.

## 6. Generate And Stream Tokens

Now the payoff. Add the generation loop inside the click handler, right after
`ensureReady()`:

```ts
  statusEl.textContent = 'generating';
  outputEl.textContent = '';
  usageEl.textContent = '';

  const messages = [
    { role: 'user' as const, text: 'Explain WebGPU in one short paragraph.' },
  ];

  for await (const event of engine.generate(messages)) {
    if (event.kind === 'token') {
      outputEl.textContent += event.text;
    } else if (event.kind === 'usage') {
      const tps = (event.outputTokens / (event.decodeMs / 1000)).toFixed(1);
      usageEl.textContent =
        `${event.promptTokens} in / ${event.outputTokens} out (${tps} tok/s)`;
    } else if (event.kind === 'error') {
      statusEl.textContent = event.message;
    }
  }

  statusEl.textContent = 'ready';
  buttonEl.disabled = false;
```

`generate(messages)` returns an `AsyncIterable<EngineEvent>`. Each message is
an `EngineMessage` with a `role` and `text`. You drive the stream with
`for await`.

You will see `token` events arrive one chunk at a time. Append each
`event.text` to the output element and the reply types itself onto the page.
When decoding finishes, a single `usage` event arrives with `promptTokens`,
`outputTokens`, and `decodeMs`. We use those to print a tokens-per-second
figure. An `error` event, if it ever appears, carries a `message`.

## 7. Run It

Start your dev server and open the page:

```sh
npm run dev
```

Click **Load + generate**. The first run is slow: the status line fills with
fetch progress as the 180 MB downloads, then switches to a compile message.
Notice that nothing appears in the output pane during this phase. That is
expected. Cold start is front-loaded.

Once the status reads `generating`, watch the output pane. Tokens stream in,
and the reply builds up word by word. When it stops, the usage line appears
below it.

Now reload the page and click again. This time the fetch phase is gone. The
weights are cached, so the model is ready in a fraction of the time, and decode
runs at the same warm speed. That contrast between a slow cold start and a fast
warm path is the shape of on-device inference.

## What You Built

You loaded a real language model into a browser tab, showed its download and
compile progress, and streamed a generated reply into the page using only
`createEngine`, `ensureReady`, and `generate`. The whole thing ran on the
user's device.

## Next

- Loading a 180 MB model on the main thread froze nothing here because it is
  small, but a larger model would. Move the engine off the main thread in
  [Run The Model In A Worker](./02-run-the-model-in-a-worker.md).
- Picking the right model for your hardware and task is a decision in itself.
  See [Choose A Preset](../how-to/choose-a-preset.md).
- Some models stream reasoning traces or call tools. See
  [Handle Thinking And Tool Calls](../how-to/handle-thinking-and-tool-calls.md).
- For the full surface of every method and event, see the
  [Engine reference](../reference/engine.md) and the
  [Presets reference](../reference/presets.md).
- To understand why inference runs in the browser at all, read
  [On-Device Inference](../explanation/on-device-inference.md).
