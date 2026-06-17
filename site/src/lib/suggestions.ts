/**
 * Empty-state prompt suggestions for the docs chat.
 *
 * Two modes, driven by the user's own question history (their prior chat
 * sessions, persisted in localStorage):
 *
 *   COLD START (no history) — orient a first-time user: getting started,
 *   integrating a model provider, the CLI, and MCP.
 *
 *   WARM (has history) — help them learn MORE: deepen the topics they've
 *   already engaged with (excluding questions they effectively already asked),
 *   then broaden into adjacent areas they haven't explored yet.
 *
 * Suggestions are drawn from a curated, docs-grounded catalog (every entry maps
 * to real content the agent can answer well) rather than generated per query —
 * deterministic, instant, and no model call. Topic detection is keyword-based
 * against the engaged packages/features.
 */
import type { Session } from './chat-store';

type Topic = 'relay' | 'resumable' | 'agent' | 'model' | 'providers' | 'cli' | 'mcp';

/** First-run orientation — exactly the getting-started / providers / CLI / MCP set. */
const COLD_START: string[] = [
  'How do I get started with inbrowser?',
  'How do I connect a model provider like Gemini or OpenRouter?',
  'How do I drive the agent from the CLI?',
  "How do I expose my agent's tools over MCP?",
];

/** "Learn more" catalog, each entry a grounded question tagged by topic. */
const CATALOG: { topic: Topic; text: string }[] = [
  { topic: 'relay', text: 'How does the relay resume a stream after a disconnect?' },
  { topic: 'relay', text: 'How do I wire the relay into a web app?' },
  { topic: 'providers', text: 'How do I write a custom relay provider?' },
  {
    topic: 'providers',
    text: 'How do I switch between Gemini, OpenRouter, Anthropic, and Ollama?',
  },
  { topic: 'resumable', text: 'How do I build a resumable stream?' },
  { topic: 'resumable', text: 'How do I use RTDB for durable jobs?' },
  { topic: 'resumable', text: 'How do resumable jobs work under the hood?' },
  { topic: 'agent', text: 'What does the agent runtime expose?' },
  { topic: 'agent', text: 'How do AgentSession, ToolRegistry, and AgentStrategy fit together?' },
  { topic: 'cli', text: 'How do I drive the agent from the CLI?' },
  { topic: 'mcp', text: 'How do I connect the agent to an MCP server?' },
  { topic: 'mcp', text: "How do I serve my agent's tools over MCP?" },
  { topic: 'model', text: 'What does @inbrowser/model do?' },
];

/** Keywords that signal a user is engaged with a topic (matched against their
 *  prior questions). */
const TOPIC_KEYWORDS: Record<Topic, string[]> = {
  relay: ['relay', 'stream', 'reconnect', 'disconnect', 'inference'],
  resumable: ['resumable', 'rtdb', 'durable', 'job', 'resume'],
  agent: ['agent', 'agentsession', 'toolregistry', 'agentstrategy', 'llmclient', 'tool'],
  model: ['@inbrowser/model', 'on-device', 'on device', 'model engine'],
  providers: ['provider', 'gemini', 'openrouter', 'anthropic', 'ollama', 'claude', 'api key'],
  cli: ['cli', 'command line', 'terminal', 'binary'],
  mcp: ['mcp', 'model context protocol'],
};

const STOP = new Set([
  'how',
  'do',
  'i',
  'the',
  'a',
  'an',
  'to',
  'with',
  'my',
  'and',
  'for',
  'of',
  'in',
  'is',
  'are',
  'what',
  'does',
]);

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const sig = (s: string): Set<string> =>
  new Set(
    norm(s)
      .split(' ')
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );

/** True when `text` is close enough to something already in `history` that
 *  re-suggesting it wouldn't help the user learn anything new. */
function alreadyAsked(history: string[], text: string): boolean {
  const t = sig(text);
  if (t.size === 0) return false;
  return history.some((h) => {
    const hw = sig(h);
    const overlap = [...t].filter((w) => hw.has(w)).length;
    return overlap / t.size >= 0.7;
  });
}

/** Build the suggestion chips for the empty state. `sessions` is the full
 *  history; the active (empty) session contributes nothing, so a returning user
 *  starting a fresh chat still gets warm suggestions from past sessions. */
export function getSuggestions(sessions: Session[], max = 4): string[] {
  const history = sessions.flatMap((s) =>
    s.messages.filter((m) => m.role === 'user').map((m) => m.text),
  );

  if (history.length === 0) return COLD_START.slice(0, max);

  const engaged = (Object.keys(TOPIC_KEYWORDS) as Topic[]).filter((t) =>
    TOPIC_KEYWORDS[t].some((k) => history.some((h) => norm(h).includes(k))),
  );

  const fresh = CATALOG.filter((c) => !alreadyAsked(history, c.text));
  const picked: string[] = [];
  const push = (text: string) => {
    if (picked.length < max && !picked.includes(text)) picked.push(text);
  };

  // 1. Deepen engaged topics. 2. Broaden into unexplored ones. 3. Top up with
  //    cold-start orientation if the catalog ran dry.
  for (const c of fresh) if (engaged.includes(c.topic)) push(c.text);
  for (const c of fresh) if (!engaged.includes(c.topic)) push(c.text);
  for (const c of COLD_START) if (!alreadyAsked(history, c)) push(c);

  return picked.slice(0, max);
}
