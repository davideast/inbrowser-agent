# Tutorial: Run The Model In A Worker

In [Run A Model In The Browser](./01-run-a-model-in-the-browser.md) we loaded a
model on the main thread. That was fine for a 360M model, but a larger model
ties up the main thread during load and decode, and the tab stops responding to
clicks and scrolls while it works.

In this tutorial we will move the same engine into a Web Worker. The model
loads and decodes off the main thread, so the page stays responsive. The
payoff to notice: your generate loop does not change at all. The object you get
back satisfies the same `Engine` shape, so the code from tutorial 01 works
unchanged.

We will keep using `smollm2_360m` so the tutorial stays reproducible.

By the end you will have:

1. a worker file that hosts the engine,
2. a main-thread connection to that worker, and
3. the exact same generate loop as before, now running off the main thread.

## Before You Start

This builds directly on tutorial 01. We assume you have that page working: a
button, a status element, an output pane, and a usage line. We will reuse all
of it and change only where the engine lives.

As before, this is browser code served through a bundler. Vite, which the
`examples/local-llm-poc` example uses, resolves the worker file for you with
its native worker support.

## 1. Create The Worker File

A worker is a separate script with its own global scope. Create
`src/engine.worker.ts`:

```ts
import { hostEngineInWorker } from '@inbrowser/model/local';

hostEngineInWorker(self);
```

That is the entire worker. `hostEngineInWorker(self)` installs the worker-side
RPC: it listens for messages from the main thread, builds the real engine when
asked, and streams events back. `self` is the worker's global scope. You do not
import the preset here. The main thread sends the engine configuration across
when it connects.

## 2. Connect To The Worker From The Main Thread

Back in `src/main.ts`, replace the `createEngine` line. First, construct the
`Worker`, then connect to it:

```ts
import { connectWorkerEngine, smollm2_360m } from '@inbrowser/model/local';

const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), {
  type: 'module',
});

const engine = connectWorkerEngine({
  worker,
  engine: smollm2_360m,
});
```

`new Worker(new URL(...))` is how a bundler is told to build the worker as a
separate entry point. `connectWorkerEngine` takes the `Worker` and the same
preset you would have passed to `createEngine`, and returns an `Engine`.

Under the hood it sends the preset to the worker, performs a handshake, and
gives you a stub. The stub forwards every call across postMessage. The worker
runs the real engine.

## 3. Keep Everything Else The Same

This is the teaching point of the tutorial, so look closely. Your load
subscriptions and your generate loop do not change:

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

buttonEl.addEventListener('click', async () => {
  buttonEl.disabled = true;

  await engine.ensureReady();

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
});
```

`ensureReady()`, `on('load', ...)`, `on('state', ...)`, and `generate()` all
behave exactly as in tutorial 01. The `LoadProgress` events flow back from the
worker, so your status line still updates as the model downloads and compiles.
The `token`, `usage`, and `error` events arrive over the same stream. The only
difference is where the work happens.

## 4. Run It

Start your dev server and open the page:

```sh
npm run dev
```

Click **Load + generate**. You will see the same progression: fetch progress in
the status line, then a compile message, then tokens streaming into the output
pane, then the usage line.

Now do the thing the worker exists for. While the model is loading or decoding,
interact with the page. Select text, scroll, hover over the button. The page
stays responsive throughout, because the engine is running on a different
thread. In tutorial 01, that same interaction during a large model's load would
have stuttered or frozen.

## 5. Tear Down When Done

Because the engine lives in a worker, disposing it also tears down the
transport. Call `dispose` when you are finished:

```ts
await engine.dispose();
worker.terminate();
```

`engine.dispose()` tells the worker to release the engine and closes the RPC
channel. `worker.terminate()` then shuts down the worker thread itself.

## What You Built

You moved a real on-device engine into a Web Worker and kept the page
responsive during load and decode, without changing your generate loop. The
worker hosts the engine with `hostEngineInWorker(self)`, the main thread
connects with `connectWorkerEngine`, and the returned object is the same
`Engine` shape you already knew how to use.

## Next

- Choosing a model that fits your hardware matters more once you can afford to
  run a bigger one off the main thread. See
  [Choose A Preset](../how-to/choose-a-preset.md).
- The worker engine is a drop-in `Engine`, so anything that drives the engine
  directly drives the worker engine identically. Plugging a local engine into
  the relay or agent (as a `ModelClient`) is not wired yet — see
  [Use A Local Model In Relay](../how-to/use-a-local-model-in-relay.md) and
  [Use A Local Model In The Agent](../how-to/use-a-local-model-in-the-agent.md)
  for the current state and the forthcoming wrapper.
- For the full handshake options and worker wire protocol, see the
  [Adapters and worker reference](../reference/adapters-and-worker.md) and the
  [Engine reference](../reference/engine.md).
- To understand why the worker stub can stand in for the real engine
  transparently, read [Design](../explanation/design.md).
