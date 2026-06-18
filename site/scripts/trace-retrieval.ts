import {
  createAgentSession,
  createDispatch,
  createMetricsCollector,
  createRetrievalStrategy,
} from '@inbrowser/agent';
import { createGraphToolRegistry } from '../src/agent/graph-tools';

let captured: { messages: { role: string; text?: string }[] } | null = null;
const llm = {
  id: 'trace',
  supportsTools: false,
  // biome-ignore lint/correctness/useYield: trace stub
  async *chat(req: { messages: { role: string; text?: string }[] }) {
    captured = req;
    yield { kind: 'text', text: '(dummy)' } as const;
    yield { kind: 'usage', usage: { promptTokens: 0, outputTokens: 0 } } as const;
  },
};

const q = process.argv.slice(2).join(' ') || 'How do I switch between Gemini, OpenRouter, Anthropic, and Ollama?';
const registry = createGraphToolRegistry();
const session = createAgentSession({
  // biome-ignore lint/suspicious/noExplicitAny: trace
  strategy: createRetrievalStrategy() as any,
  // biome-ignore lint/suspicious/noExplicitAny: trace
  llm: llm as any,
  tools: createDispatch(registry),
  toolList: registry.list(),
  toolContext: () => ({ signal: new AbortController().signal }),
  systemPromptBuilder: () => 'sys',
  metrics: createMetricsCollector(),
  history: [],
});

const reads: string[] = [];
for await (const ev of session.submit(q, new AbortController().signal)) {
  if (ev.kind === 'tool_started') reads.push(`${ev.name}(${JSON.stringify(ev.args)})`);
}
console.log(`QUERY: ${q}\n`);
console.log('TOOL CALLS the strategy made:');
for (const r of reads) console.log(`  ${r}`);
const userMsg = captured?.messages?.filter((m) => m.role === 'user').pop()?.text ?? '';
const routes = [...userMsg.matchAll(/--- \[([^\]]+)\]/g)].map((m) => m[1]);
console.log(`\nCONTEXT routes stuffed into the model prompt: ${routes.join(', ') || '(none)'}`);
