# Tutorial: Drive A Session From Your Code

In this tutorial we will build a complete agent session in TypeScript and watch
it run. The session will call a tool, then write a reply. No API key, no model
provider, and no network are required: we supply a tiny scripted LLM that stands
in for a real one, so the lesson runs the same way every time.

By the end you will have a single file you can run with `bun run`, and you will
have seen every stage of a session stream past in your terminal.

## 1. Create The File

We will put everything in one file. Create `session-demo.ts`:

```bash
touch session-demo.ts
```

Open it and add the imports. These are the five primitives the runtime gives
you:

```ts
import {
  createAgentSession,
  createReactLoopStrategy,
  createToolRegistry,
  createDispatch,
  createMetricsCollector,
  type ModelClient,
  type ToolHandler,
} from '@inbrowser/agent';
```

`createAgentSession` builds the session. `createReactLoopStrategy` is the loop
that drives it. `createToolRegistry` and `createDispatch` wire up the tools.
`createMetricsCollector` tallies token usage per turn.

## 2. Register A Tool

A tool is a named function the agent can call. We will register one tool that
reports the current time. Add this below the imports:

```ts
const clockTool: ToolHandler<{ zone?: string }> = {
  name: 'get_time',
  description: 'Return the current time as an ISO-8601 string.',
  parameters: {
    type: 'object',
    properties: {
      zone: { type: 'string', description: 'IANA time zone, e.g. UTC' },
    },
  },
  async execute(args, ctx) {
    // `ctx.signal` is the cancellation signal (always present).
    void ctx.signal;
    const now = new Date().toISOString();
    return {
      ok: true,
      summary: `current time is ${now}`,
      data: { iso: now, zone: args.zone ?? 'UTC' },
    };
  },
};

const registry = createToolRegistry();
registry.register(clockTool);
```

Notice that `execute` returns a `ToolResult`: an `ok` flag, a one-line `summary`
the agent can quote back, and an optional `data` payload. The `parameters` field
is plain JSON Schema, which is what the LLM sees when it decides to call the
tool.

## 3. Write A Scripted LLM

The bare runtime ships no built-in model, so we provide our own `ModelClient`. A
real client streams chunks from a provider; ours follows a fixed script so the
lesson is perfectly repeatable.

Our script runs in two turns. On the first turn it asks to call `get_time`. On
the second turn (after it has seen the tool result) it writes a sentence and
finishes:

```ts
const scriptedLlm: ModelClient = {
  id: 'scripted-demo',
  supportsTools: true,
  chat(req, signal) {
    void signal;
    // Count how many tool results are already in the conversation.
    const toolTurns = req.messages.filter((m) => m.role === 'tool').length;
    return (async function* () {
      if (toolTurns === 0) {
        // First turn: ask to call the tool.
        yield { kind: 'thinking', text: 'I should check the clock.\n' };
        yield {
          kind: 'tool_call',
          id: 'call-1',
          name: 'get_time',
          args: { zone: 'UTC' },
        };
        yield { kind: 'usage', usage: { promptTokens: 20, outputTokens: 8 } };
        return;
      }
      // Second turn: the tool result is now in `req.messages`. Reply.
      for (const word of 'Here is the time you asked for.'.split(' ')) {
        yield { kind: 'text', text: word + ' ' };
      }
      yield { kind: 'usage', usage: { promptTokens: 30, outputTokens: 7 } };
    })();
  },
};
```

Notice the `usage` event at the end of each turn. It carries the final token
counts, and a turn ends when the generator returns — there is no separate
`turn_complete` event. The session reads `usage` to record metrics and emit its
own `turn_completed` event, so a scripted client should always emit one before
it finishes (the session synthesizes the model name from the client `id`).

## 4. Assemble The Session

Now we hand all the parts to `createAgentSession`. The strategy loops, the LLM
decides, the tools execute, and the metrics collector keeps score:

```ts
const session = createAgentSession({
  id: 'demo-session',
  strategy: createReactLoopStrategy(),
  llm: scriptedLlm,
  tools: createDispatch(registry),
  toolList: registry.list(),
  toolContext: () => ({ signal: new AbortController().signal }),
  metrics: createMetricsCollector(),
  history: [],
  systemPromptBuilder: () => 'You are a helpful assistant with a clock tool.',
});
```

Notice three things. `tools` is a dispatcher built from the registry, while
`toolList` is the plain list of handlers the LLM is shown. `toolContext` is a
factory that returns a fresh context (with the required `signal`) on every tool
call. `history` is empty because this is a brand-new conversation.

## 5. Run It And Print Every Event

Finally we submit a prompt and loop over the event stream. `session.submit`
returns an async iterable; each value is a `SessionEvent`. We print the kind of
each one so we can watch the session unfold:

```ts
const signal = new AbortController().signal;

for await (const event of session.submit('What time is it?', signal)) {
  switch (event.kind) {
    case 'turn_started':
      console.log(`-- turn ${event.turnId} started`);
      break;
    case 'thinking':
      process.stdout.write(`[thinking] ${event.chunk}`);
      break;
    case 'tool_started':
      console.log(`[tool] calling ${event.name} with`, event.args);
      break;
    case 'tool_finished':
      console.log(`[tool] ${event.result.summary}`);
      break;
    case 'text':
      process.stdout.write(event.chunk);
      break;
    case 'turn_completed':
      console.log(`\n-- turn done · ${event.metrics.tokensOut} output tokens`);
      break;
    case 'completed':
      console.log('-- session complete');
      break;
    case 'error':
      console.error(`[error] ${event.message}`);
      break;
  }
}
```

Save the file and run it:

```bash
bun run session-demo.ts
```

You will see the session play out in order:

```text
-- turn t-... started
[thinking] I should check the clock.
[tool] calling get_time with { zone: 'UTC' }
[tool] current time is 2026-06-17T...Z
Here is the time you asked for.
-- turn done · 7 output tokens
-- session complete
```

Notice the shape of the run: the agent thought, called your tool, received the
result, and then wrote its reply. The `completed` event fires exactly once, when
the whole submit has finished.

## What You Built

You drove a full agent session in code with no external services. You
registered a tool, scripted a `ModelClient` to call it, assembled a session with
`createAgentSession`, and consumed the typed `SessionEvent` stream. This is the
same library surface the playground UI consumes; only the model client differs.

Try changing the scripted reply text and running it again. Then add a second
property to `clockTool`'s schema and have the script pass it in `args`. The loop
stays the same; only your script changes.

## Next

- To swap the scripted client for a real provider, follow
  [Implement a custom `ModelClient`](../how-to/implement-llm-client.md).
- For the full list of event kinds and their fields, see the
  [`SessionEvent` reference](../reference/events.md).
