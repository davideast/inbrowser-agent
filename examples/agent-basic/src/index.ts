import {
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type ModelClient,
  type ModelEvent,
  type SessionEvent,
  type ToolContext,
  createAgentSession,
  createAgentTools,
  createMetricsCollector,
  createReactLoopStrategy,
  createToolRegistry,
} from '@inbrowser/agent';

export interface AgentBasicResult {
  events: SessionEvent[];
  text: string;
  thinking: string;
  toolSummaries: string[];
  finalRules: string;
}

function scriptedModel(scripts: ModelEvent[][]): ModelClient {
  let turn = 0;
  return {
    id: 'scripted-model',
    supportsTools: true,
    chat() {
      const events = scripts[turn] ?? [];
      turn += 1;
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
}

function toolContext(): ToolContext {
  return {
    signal: new AbortController().signal,
    workspace: EMPTY_WORKSPACE,
    runtime: EMPTY_RUNTIME,
  };
}

async function collectSession(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const collected: SessionEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

export async function runBasicAgentFlow(): Promise<AgentBasicResult> {
  const registry = createToolRegistry();
  registry.register({
    name: 'write_rules',
    description: 'Write Firestore rules into the session workspace.',
    parameters: {
      type: 'object',
      properties: { source: { type: 'string' } },
      required: ['source'],
    },
    async execute(args) {
      const source = String((args as { source?: unknown }).source ?? '');
      return {
        ok: true,
        summary: `wrote ${source.length} chars`,
        workspacePatch: { rules: source },
      };
    },
  });

  const llm = scriptedModel([
    [
      { kind: 'thinking', text: 'Need to call the workspace mutation tool.' },
      {
        kind: 'tool_call',
        id: 'call_1',
        name: 'write_rules',
        args: {
          source:
            'rules_version = "2";\nservice cloud.firestore { match /databases/{db}/documents { } }',
        },
      },
      { kind: 'usage', usage: { promptTokens: 20, outputTokens: 9 } },
    ],
    [
      { kind: 'text', text: 'Rules were written to the session workspace.' },
      { kind: 'usage', usage: { promptTokens: 28, outputTokens: 8 } },
    ],
  ]);

  const session = createAgentSession({
    strategy: createReactLoopStrategy(),
    llm,
    tools: createAgentTools(registry),
    toolContext,
    systemPromptBuilder: () => 'You are a small deterministic demo agent.',
    metrics: createMetricsCollector(),
    history: [],
  });

  const events = await collectSession(
    session.submit('Write a starter rules file.', new AbortController().signal),
  );
  const text = events
    .filter((event): event is Extract<SessionEvent, { kind: 'text' }> => event.kind === 'text')
    .map((event) => event.chunk)
    .join('');
  const thinking = events
    .filter(
      (event): event is Extract<SessionEvent, { kind: 'thinking' }> => event.kind === 'thinking',
    )
    .map((event) => event.chunk)
    .join('');
  const toolSummaries = events
    .filter(
      (event): event is Extract<SessionEvent, { kind: 'tool_finished' }> =>
        event.kind === 'tool_finished',
    )
    .map((event) => event.result.summary);

  return { events, text, thinking, toolSummaries, finalRules: session.workspace.rules };
}

if (import.meta.main) {
  const result = await runBasicAgentFlow();

  console.log('\nAgent session events');
  for (const event of result.events) {
    if (event.kind === 'tool_started') console.log(`- tool_started ${event.name}`);
    else if (event.kind === 'tool_finished') console.log(`- tool_finished ${event.result.summary}`);
    else if (event.kind === 'text') console.log(`- text ${event.chunk}`);
    else if (event.kind === 'thinking') console.log(`- thinking ${event.chunk}`);
    else console.log(`- ${event.kind}`);
  }

  console.log('\nFinal answer');
  console.log(result.text);

  console.log('\nWorkspace rules');
  console.log(result.finalRules.trim());
}
