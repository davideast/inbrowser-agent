/**
 * Content graph for the inbrowser docs site.
 *
 * Single source of truth for navigation, breadcrumbs, routing, and (in
 * Phase 2) the agent's dynamic lookup. Nodes are doc pages sourced from
 * the existing package markdown — nothing under `packages/**` is edited;
 * all display metadata lives here.
 *
 * Phase 1 uses the hierarchy (package -> category -> reading order) plus
 * `summary`. Phase 2's `scripts/build-graph.ts` enriches this with the
 * markdown body + typed cross-link edges for the agent.
 */

export type PackageId =
  | 'overview'
  | 'agent'
  | 'workspace'
  | 'sandbox'
  | 'relay'
  | 'resumable'
  | 'model';

export type Category =
  | 'overview'
  | 'tutorial'
  | 'how-to'
  | 'design'
  | 'explanation'
  | 'reference'
  | 'agent-context'
  | 'skill';

export interface DocNode {
  /** Stable key — the route without its leading slash (e.g. `relay/reference`). */
  id: string;
  package: PackageId;
  category: Category;
  /** Page title (matches the source doc's H1). */
  title: string;
  /** Site route, leading slash (e.g. `/relay/reference`). */
  route: string;
  /** Repo-root-relative path to the source markdown. */
  sourcePath: string;
  /** One-line summary — shown under the page title and reused as the
   *  agent's node summary in Phase 2. */
  summary: string;
}

export const PACKAGE_ORDER: PackageId[] = [
  'overview',
  'agent',
  'workspace',
  'sandbox',
  'relay',
  'resumable',
  'model',
];

export const PACKAGE_LABELS: Record<PackageId, string> = {
  overview: 'Overview',
  agent: '@inbrowser/agent',
  workspace: '@inbrowser/workspace',
  sandbox: '@inbrowser/sandbox',
  relay: '@inbrowser/relay',
  resumable: '@inbrowser/resumable',
  model: '@inbrowser/model',
};

export const CATEGORY_LABELS: Record<Category, string> = {
  overview: 'Overview',
  tutorial: 'Tutorial',
  'how-to': 'How-To',
  design: 'Design',
  explanation: 'Explanation',
  reference: 'Reference',
  'agent-context': 'Agent Context',
  skill: 'Skill',
};

/**
 * Every doc node, in global reading order (drives prev/next). Within a
 * package the order is overview -> tutorial -> how-to -> design ->
 * reference -> agent-context -> skill.
 */
export const NODES: DocNode[] = [
  // ── Overview (repo-level) ──────────────────────────────────────────
  {
    id: 'overview',
    package: 'overview',
    category: 'overview',
    title: 'inbrowser',
    route: '/overview',
    sourcePath: 'README.md',
    summary:
      'The inbrowser monorepo: a resumable job engine, an inference relay, an agent runtime, and an on-device model engine.',
  },
  {
    id: 'overview/agent-context',
    package: 'overview',
    category: 'agent-context',
    title: 'Agent context for the inbrowser monorepo',
    route: '/overview/agent-context',
    sourcePath: 'AGENTS.md',
    summary: 'Repo shape, conventions, and invariants for agents working across the monorepo.',
  },

  // ── @inbrowser/agent ───────────────────────────────────────────────
  {
    id: 'agent',
    package: 'agent',
    category: 'overview',
    title: '@inbrowser/agent',
    route: '/agent',
    sourcePath: 'packages/agent/README.md',
    summary:
      'Agent runtime plus an agent-friendly CLI: AgentSession, AgentStrategy, ToolRegistry, ModelClient, and an `agent` binary.',
  },
  {
    id: 'agent/tutorials/drive-a-session-from-code',
    package: 'agent',
    category: 'tutorial',
    title: 'Tutorial: Drive A Session From Your Code',
    route: '/agent/tutorials/drive-a-session-from-code',
    sourcePath: 'packages/agent/docs/tutorials/01-drive-a-session-from-code.md',
    summary:
      'Build a complete agent session in TypeScript with a scripted LLM (no API key or network) that calls a tool then writes a reply.',
  },
  {
    id: 'agent/tutorials/run-the-agent-cli',
    package: 'agent',
    category: 'tutorial',
    title: 'Tutorial: Run The Agent CLI',
    route: '/agent/tutorials/run-the-agent-cli',
    sourcePath: 'packages/agent/docs/tutorials/02-run-the-agent-cli.md',
    summary:
      'Drive the `agent` binary: discover its schema, run a scripted scenario, read the NDJSON event stream, and find the durable session log.',
  },
  {
    id: 'agent/tutorials/serve-agents-over-mcp',
    package: 'agent',
    category: 'tutorial',
    title: 'Tutorial: Serve Agents Over MCP',
    route: '/agent/tutorials/serve-agents-over-mcp',
    sourcePath: 'packages/agent/docs/tutorials/03-serve-agents-over-mcp.md',
    summary:
      'Expose your own tools to an external host over MCP: define an agent, stand up an MCP stdio server, and point a host at it.',
  },
  {
    id: 'agent/how-to/implement-llm-client',
    package: 'agent',
    category: 'how-to',
    title: 'How to implement a custom ModelClient',
    route: '/agent/how-to/implement-llm-client',
    sourcePath: 'packages/agent/docs/how-to/implement-llm-client.md',
    summary:
      'Plug an upstream LLM API into a session by implementing the narrow `ModelClient.chat()` async generator and mapping its stream to ModelEvents.',
  },
  {
    id: 'agent/how-to/consume-an-mcp-server',
    package: 'agent',
    category: 'how-to',
    title: 'How to consume an external MCP server',
    route: '/agent/how-to/consume-an-mcp-server',
    sourcePath: 'packages/agent/docs/how-to/consume-an-mcp-server.md',
    summary:
      'Give an agent the tools from an external MCP server with `connectMcpTools`, so the session calls them through the same in-process loop.',
  },
  {
    id: 'agent/how-to/define-and-register-tools',
    package: 'agent',
    category: 'how-to',
    title: 'How to define and register tools',
    route: '/agent/how-to/define-and-register-tools',
    sourcePath: 'packages/agent/docs/how-to/define-and-register-tools.md',
    summary:
      'Define a ToolHandler, register it in a ToolRegistry, and dispatch it, including mutating session state and marking read-only tools parallel-safe.',
  },
  {
    id: 'agent/how-to/inspect-and-undo-with-the-event-log',
    package: 'agent',
    category: 'how-to',
    title: 'How to inspect and undo with the event log',
    route: '/agent/how-to/inspect-and-undo-with-the-event-log',
    sourcePath: 'packages/agent/docs/how-to/inspect-and-undo-with-the-event-log.md',
    summary:
      'Audit what an agent did to a project and reverse a mutating commit using the `agent` CLI against the per-project append-only event log.',
  },
  {
    id: 'agent/reference/library',
    package: 'agent',
    category: 'reference',
    title: 'Library Reference',
    route: '/agent/reference/library',
    sourcePath: 'packages/agent/docs/reference/library.md',
    summary:
      'The public library surface of `@inbrowser/agent`, exposed across three import subpaths.',
  },
  {
    id: 'agent/reference/cli',
    package: 'agent',
    category: 'reference',
    title: 'CLI Reference',
    route: '/agent/reference/cli',
    sourcePath: 'packages/agent/docs/reference/cli.md',
    summary:
      'The `agent` binary, derived from CLI_SPEC, the single source of truth the parser and the schema/describe commands surface verbatim.',
  },
  {
    id: 'agent/reference/events',
    package: 'agent',
    category: 'reference',
    title: 'Event Reference',
    route: '/agent/reference/events',
    sourcePath: 'packages/agent/docs/reference/events.md',
    summary:
      'The three discriminated-union event streams in `@inbrowser/agent`, each a typed AsyncIterable consumed at a different layer.',
  },
  {
    id: 'agent/explanation/inference-vs-inverse',
    package: 'agent',
    category: 'explanation',
    title: 'Inference vs Inverse: The Two Consumer Modes',
    route: '/agent/explanation/inference-vs-inverse',
    sourcePath: 'packages/agent/docs/explanation/inference-vs-inverse.md',
    summary:
      'The two ways to consume the package come down to who owns the loop, the single most important mental model for working with it.',
  },
  {
    id: 'agent/explanation/how-the-react-loop-works',
    package: 'agent',
    category: 'explanation',
    title: 'How the ReAct Loop Works',
    route: '/agent/explanation/how-the-react-loop-works',
    sourcePath: 'packages/agent/docs/explanation/how-the-react-loop-works.md',
    summary:
      'What createReactLoopStrategy() is, why it is shaped that way, and the trade-offs baked into its two optional behaviours.',
  },
  {
    id: 'agent/agent-context',
    package: 'agent',
    category: 'agent-context',
    title: 'AGENTS.md — @inbrowser/agent',
    route: '/agent/agent-context',
    sourcePath: 'packages/agent/AGENTS.md',
    summary:
      'Invariants, anti-patterns, and workflow patterns for driving the agent runtime and CLI.',
  },
  {
    id: 'agent/skill-cli',
    package: 'agent',
    category: 'skill',
    title: 'Skill: drive the agent CLI',
    route: '/agent/skill-cli',
    sourcePath: 'packages/agent/skills/agent-cli.md',
    summary:
      'Step-by-step skill for running sessions, fleets, event-sourced audit/undo, and forward replay through the CLI.',
  },

  // ── @inbrowser/workspace ──────────────────────────────────────────
  {
    id: 'workspace',
    package: 'workspace',
    category: 'overview',
    title: '@inbrowser/workspace',
    route: '/workspace',
    sourcePath: 'packages/workspace/README.md',
    summary:
      'Browser-native workspace runtime: OPFS/memory files, esbuild preview compilation, jailed browser shell, isomorphic-git, package import maps, and optional agent tool adapters.',
  },
  {
    id: 'workspace/tutorial',
    package: 'workspace',
    category: 'tutorial',
    title: 'Tutorial: Create A Browser Workspace',
    route: '/workspace/tutorial',
    sourcePath: 'packages/workspace/docs/tutorial.md',
    summary:
      'Create a browser workspace, write a tiny React app into /work, and prepare file, shell, and git services for an app-builder agent.',
  },
  {
    id: 'workspace/how-to/preview-a-react-app',
    package: 'workspace',
    category: 'how-to',
    title: 'How To Preview A React App Without A Dev Server',
    route: '/workspace/how-to/preview-a-react-app',
    sourcePath: 'packages/workspace/docs/how-to-preview-a-react-app.md',
    summary:
      'Preview a React/TSX app by compiling the workspace entry module and evaluating it with host-provided React modules.',
  },
  {
    id: 'workspace/reference',
    package: 'workspace',
    category: 'reference',
    title: 'API Reference',
    route: '/workspace/reference',
    sourcePath: 'packages/workspace/docs/reference.md',
    summary:
      'The public surface of @inbrowser/workspace: workspace creation, file systems, preview, shell, git, packages, and agent tools.',
  },
  {
    id: 'workspace/explanation/why-not-browser-node',
    package: 'workspace',
    category: 'explanation',
    title: 'Why This Is Not Browser Node',
    route: '/workspace/explanation/why-not-browser-node',
    sourcePath: 'packages/workspace/docs/why-not-browser-node.md',
    summary:
      'Why the workspace runtime chooses compile-and-mount preview, host modules, structured shell/git/package services, and explicit limits over a partial browser Node illusion.',
  },

  // ── @inbrowser/sandbox ────────────────────────────────────────────
  {
    id: 'sandbox',
    package: 'sandbox',
    category: 'overview',
    title: '@inbrowser/sandbox',
    route: '/sandbox',
    sourcePath: 'packages/sandbox/README.md',
    summary:
      'Sandbox orchestration above @inbrowser/workspace: runtime events, standard agent tools, checkpoints, and a workspace adapter for browser-native app builders.',
  },
  {
    id: 'sandbox/explanation/overview',
    package: 'sandbox',
    category: 'explanation',
    title: 'Sandbox Architecture Overview',
    route: '/sandbox/explanation/overview',
    sourcePath: 'packages/sandbox/docs/overview.md',
    summary:
      'How @inbrowser/sandbox absorbs Piebox-shaped orchestration into the inbrowser package suite while keeping runtime substrate, workspace services, and agent loops separate.',
  },
  {
    id: 'sandbox/how-to/wire-an-agent',
    package: 'sandbox',
    category: 'how-to',
    title: 'How To Wire A Sandbox Into An Agent',
    route: '/sandbox/how-to/wire-an-agent',
    sourcePath: 'packages/sandbox/docs/how-to-wire-an-agent.md',
    summary:
      'Expose browser workspace tools to an @inbrowser/agent session with @inbrowser/sandbox and the @inbrowser/agent/sandbox bridge.',
  },
  {
    id: 'sandbox/how-to/manage-checkpoint-history',
    package: 'sandbox',
    category: 'how-to',
    title: 'How To Manage Checkpoint History',
    route: '/sandbox/how-to/manage-checkpoint-history',
    sourcePath: 'packages/sandbox/docs/how-to-manage-checkpoint-history.md',
    summary:
      'Create, restore, query, and prune sandbox checkpoints with turn, message, and tool-call metadata for agent-session restore flows.',
  },
  {
    id: 'sandbox/explanation/sandbox-agent-tools',
    package: 'sandbox',
    category: 'explanation',
    title: 'Why Sandbox Tools And Agent Tools Are Separate',
    route: '/sandbox/explanation/sandbox-agent-tools',
    sourcePath: 'packages/sandbox/docs/why-sandbox-and-agent-tools-are-separate.md',
    summary:
      'Why sandbox side effects stay on the sandbox, agent policy stays in @inbrowser/agent, and createSandboxAgentTools adapts between them.',
  },
  {
    id: 'sandbox/reference',
    package: 'sandbox',
    category: 'reference',
    title: 'API Reference',
    route: '/sandbox/reference',
    sourcePath: 'packages/sandbox/docs/reference.md',
    summary:
      'The public surface of @inbrowser/sandbox: sandbox contracts, workspace adapter, standard tools, checkpoints, events, and the agent bridge.',
  },
  {
    id: 'sandbox/agent-context',
    package: 'sandbox',
    category: 'agent-context',
    title: 'AGENTS.md — @inbrowser/sandbox',
    route: '/sandbox/agent-context',
    sourcePath: 'packages/sandbox/AGENTS.md',
    summary: 'Package invariants for sandbox tools, events, checkpoints, and workspace adapters.',
  },

  // ── @inbrowser/relay ───────────────────────────────────────────────
  {
    id: 'relay',
    package: 'relay',
    category: 'overview',
    title: '@inbrowser/relay',
    route: '/relay',
    sourcePath: 'packages/relay/README.md',
    summary:
      'Resumable LLM inference relay: a pure transport that serves ModelClient factories from @inbrowser/model over HTTP, plus a reconnecting browser client.',
  },
  {
    id: 'relay/tutorial',
    package: 'relay',
    category: 'tutorial',
    title: 'Tutorial: Create A Relay With A Fake Provider',
    route: '/relay/tutorial',
    sourcePath: 'packages/relay/docs/tutorial.md',
    summary:
      'Build a relay over a memory store and a fake provider, start a job, stream it, and resume from an offset.',
  },
  {
    id: 'relay/wire-a-web-app',
    package: 'relay',
    category: 'how-to',
    title: 'How To Wire A Web App',
    route: '/relay/wire-a-web-app',
    sourcePath: 'packages/relay/docs/how-to-wire-a-web-app.md',
    summary:
      'Mount the relay in Astro, Express, or any Web-standard runtime, and consume the stream from the browser.',
  },
  {
    id: 'relay/write-a-provider',
    package: 'relay',
    category: 'how-to',
    title: 'How To Write A Provider',
    route: '/relay/write-a-provider',
    sourcePath: 'packages/relay/docs/how-to-write-a-provider.md',
    summary:
      'Implement a ModelClient for an upstream LLM: parse SSE upstreams, emit ModelEvent tool calls, and register it as a ModelClientFactory.',
  },
  {
    id: 'relay/use-a-subscription-provider',
    package: 'relay',
    category: 'how-to',
    title: 'How To Use A Subscription Claude Provider',
    route: '/relay/use-a-subscription-provider',
    sourcePath: 'packages/relay/docs/how-to-use-a-subscription-provider.md',
    summary:
      'Reach Claude through a subscription with no API key, using the claude-code (Agent SDK) or claude-cli (claude -p) providers.',
  },
  {
    id: 'relay/how-it-works',
    package: 'relay',
    category: 'explanation',
    title: 'How The Relay Works',
    route: '/relay/how-it-works',
    sourcePath: 'packages/relay/docs/how-it-works.md',
    summary:
      'The job lifecycle, why providers and adapters are separate, what is stored, and offset-based replay.',
  },
  {
    id: 'relay/reference',
    package: 'relay',
    category: 'reference',
    title: 'API Reference',
    route: '/relay/reference',
    sourcePath: 'packages/relay/docs/reference.md',
    summary:
      'createRelay, NormalizedRequest, the re-exported ModelEvent/ModelClient contract types, ModelClientFactory, the handlers, adapters, SSE helpers, and the client.',
  },

  // ── @inbrowser/resumable ───────────────────────────────────────────
  {
    id: 'resumable',
    package: 'resumable',
    category: 'overview',
    title: '@inbrowser/resumable',
    route: '/resumable',
    sourcePath: 'packages/resumable/README.md',
    summary:
      'Resumable streaming-job engine: a pluggable JobStore plus a JobEngine that streams events into a durable, tailable log.',
  },
  {
    id: 'resumable/tutorial',
    package: 'resumable',
    category: 'tutorial',
    title: 'Tutorial: Build A Resumable Stream',
    route: '/resumable/tutorial',
    sourcePath: 'packages/resumable/docs/tutorial.md',
    summary:
      'Create the engine, start a producer, read the stream, replay from an offset, and stop cleanly.',
  },
  {
    id: 'resumable/use-rtdb',
    package: 'resumable',
    category: 'how-to',
    title: 'How To Use RTDB For Durable Jobs',
    route: '/resumable/use-rtdb',
    sourcePath: 'packages/resumable/docs/how-to-use-rtdb.md',
    summary:
      'Configure the Firebase RTDB store, add the sweep index, use a service-account token provider, and verify durability.',
  },
  {
    id: 'resumable/how-it-works',
    package: 'resumable',
    category: 'explanation',
    title: 'How Resumable Jobs Work',
    route: '/resumable/how-it-works',
    sourcePath: 'packages/resumable/docs/how-it-works.md',
    summary:
      'Engine and store, sequence numbers as the resume contract, terminal state vs events, and TTL retention.',
  },
  {
    id: 'resumable/reference',
    package: 'resumable',
    category: 'reference',
    title: 'API Reference',
    route: '/resumable/reference',
    sourcePath: 'packages/resumable/docs/reference.md',
    summary:
      'createJobEngine, the producer surface, subscription events, the JobStore contract, memory + RTDB stores, and sweeps.',
  },

  // ── @inbrowser/model ───────────────────────────────────────────────
  {
    id: 'model',
    package: 'model',
    category: 'overview',
    title: '@inbrowser/model',
    route: '/model',
    sourcePath: 'packages/model/README.md',
    summary:
      'The model layer: the one ModelClient contract, the cloud provider factories that implement it, and an on-device LLM engine over @huggingface/transformers + ONNX. The engine is not yet a ModelClient.',
  },
  {
    id: 'model/tutorials/run-a-model-in-the-browser',
    package: 'model',
    category: 'tutorial',
    title: 'Tutorial: Run A Model In The Browser',
    route: '/model/tutorials/run-a-model-in-the-browser',
    sourcePath: 'packages/model/docs/tutorials/01-run-a-model-in-the-browser.md',
    summary:
      'Load a small language model into a browser tab and stream its reply token by token, with no server, API key, or cloud inference.',
  },
  {
    id: 'model/tutorials/run-the-model-in-a-worker',
    package: 'model',
    category: 'tutorial',
    title: 'Tutorial: Run The Model In A Worker',
    route: '/model/tutorials/run-the-model-in-a-worker',
    sourcePath: 'packages/model/docs/tutorials/02-run-the-model-in-a-worker.md',
    summary:
      'Move the same engine into a Web Worker so the model loads and decodes off the main thread and the page stays responsive.',
  },
  {
    id: 'model/how-to/choose-a-preset',
    package: 'model',
    category: 'how-to',
    title: 'How To Choose A Preset',
    route: '/model/how-to/choose-a-preset',
    sourcePath: 'packages/model/docs/how-to/choose-a-preset.md',
    summary:
      'Pick the bundled ModelPreset whose declared capabilities and download cost match what your app needs, or define your own.',
  },
  {
    id: 'model/how-to/use-a-local-model-in-relay',
    package: 'model',
    category: 'how-to',
    title: 'How To Use A Local Model In Relay',
    route: '/model/how-to/use-a-local-model-in-relay',
    sourcePath: 'packages/model/docs/how-to/use-a-local-model-in-relay.md',
    summary:
      'Register a cloud ModelClient factory in @inbrowser/relay today; serving the on-device engine the same way awaits the planned createEngineModelClient wrapper, so drive the engine directly meanwhile.',
  },
  {
    id: 'model/how-to/use-a-local-model-in-the-agent',
    package: 'model',
    category: 'how-to',
    title: 'How To Use A Local Model In The Agent',
    route: '/model/how-to/use-a-local-model-in-the-agent',
    sourcePath: 'packages/model/docs/how-to/use-a-local-model-in-the-agent.md',
    summary:
      "Pass a cloud ModelClient as a session's llm today; wiring the on-device engine the same way awaits the planned createEngineModelClient wrapper, so drive the engine directly meanwhile.",
  },
  {
    id: 'model/how-to/handle-thinking-and-tool-calls',
    package: 'model',
    category: 'how-to',
    title: 'How To Handle Thinking And Tool Calls',
    route: '/model/how-to/handle-thinking-and-tool-calls',
    sourcePath: 'packages/model/docs/how-to/handle-thinking-and-tool-calls.md',
    summary:
      "Separate a model's reasoning trace and tool-call envelopes out of the raw token stream so you can route them to different surfaces.",
  },
  {
    id: 'model/reference/engine',
    package: 'model',
    category: 'reference',
    title: 'Engine Reference',
    route: '/model/reference/engine',
    sourcePath: 'packages/model/docs/reference/engine.md',
    summary:
      'The root @inbrowser/model export: the engine factory, the Engine surface, the event vocabulary, and the stream transformers.',
  },
  {
    id: 'model/reference/presets',
    package: 'model',
    category: 'reference',
    title: 'Presets Reference',
    route: '/model/reference/presets',
    sourcePath: 'packages/model/docs/reference/presets.md',
    summary:
      'The @inbrowser/model/presets export: the six bundled ModelPreset values and the static types they carry.',
  },
  {
    id: 'model/reference/adapters-and-worker',
    package: 'model',
    category: 'reference',
    title: 'Worker Reference',
    route: '/model/reference/adapters-and-worker',
    sourcePath: 'packages/model/docs/reference/adapters-and-worker.md',
    summary:
      'The @inbrowser/model/worker subpath that hosts an Engine in a Web Worker behind the same Engine surface, plus why the removed relay/agent adapters await the planned createEngineModelClient wrapper.',
  },
  {
    id: 'model/reference/gateway-providers',
    package: 'model',
    category: 'reference',
    title: 'Gateway Provider Reference',
    route: '/model/reference/gateway-providers',
    sourcePath: 'packages/model/docs/reference/gateway-providers.md',
    summary:
      'OpenRouter and Requesty configuration, attribution headers, reasoning controls, usage telemetry, and shared OpenAI tool encoding.',
  },
  {
    id: 'model/explanation/design',
    package: 'model',
    category: 'explanation',
    title: 'Why The Engine Is Shaped This Way',
    route: '/model/explanation/design',
    sourcePath: 'packages/model/docs/explanation/design.md',
    summary:
      'The load-bearing decisions behind the small Engine surface and the trade-offs each one accepts.',
  },
  {
    id: 'model/explanation/on-device-inference',
    package: 'model',
    category: 'explanation',
    title: 'On-Device Inference',
    route: '/model/explanation/on-device-inference',
    sourcePath: 'packages/model/docs/explanation/on-device-inference.md',
    summary:
      'The stack that makes running an LLM in a browser tab possible, the constraints it imposes, and why you would choose it over the cloud.',
  },
  {
    id: 'model/agent-context',
    package: 'model',
    category: 'agent-context',
    title: 'Agent context for @inbrowser/model',
    route: '/model/agent-context',
    sourcePath: 'packages/model/AGENTS.md',
    summary: 'Purpose, layering invariants, and vocabulary for the on-device model engine.',
  },
];

/** The collection entry id for a node (glob loader strips the `.md`). */
export function entryIdOf(node: DocNode): string {
  return node.sourcePath.replace(/\.md$/, '');
}

/** Map of repo-relative target -> route, for link rewriting. Keyed by
 *  both source-path-without-extension (e.g. `packages/relay/docs/reference`)
 *  and package directory (e.g. `packages/relay` -> `/relay`) so that
 *  directory links in READMEs resolve too. */
export function buildRouteMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const node of NODES) {
    map[entryIdOf(node)] = node.route;
  }
  // Package directories -> their overview route (root READMEs link these).
  for (const pkg of ['agent', 'workspace', 'sandbox', 'relay', 'resumable', 'model'] as const) {
    map[`packages/${pkg}`] = `/${pkg}`;
  }
  return map;
}

const NODE_BY_ENTRY_ID = new Map(NODES.map((n) => [entryIdOf(n), n]));
const NODE_BY_ROUTE = new Map(NODES.map((n) => [n.route, n]));

export function nodeByEntryId(id: string): DocNode | undefined {
  return NODE_BY_ENTRY_ID.get(id);
}

export function nodeByRoute(route: string): DocNode | undefined {
  return NODE_BY_ROUTE.get(route);
}

/** The package's root (overview) route — the first node in that package. */
export function packageRootRoute(pkg: PackageId): string {
  const root = NODES.find((n) => n.package === pkg);
  return root?.route ?? '/';
}

export interface Crumb {
  label: string;
  href?: string;
}

/** Breadcrumb trail: Home / Package / Category / Page. The category
 *  segment is a label (no link); the package segment links to its root.
 *  A package-root page collapses to Home / Package. */
export function breadcrumbFor(node: DocNode): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'Home', href: '/' }];
  const rootRoute = packageRootRoute(node.package);

  if (node.route === rootRoute) {
    crumbs.push({ label: PACKAGE_LABELS[node.package] });
    return crumbs;
  }

  crumbs.push({ label: PACKAGE_LABELS[node.package], href: rootRoute });
  crumbs.push({ label: CATEGORY_LABELS[node.category] });
  crumbs.push({ label: node.title });
  return crumbs;
}

export interface NavLink {
  label: string;
  href: string;
}

/** Previous / next in global reading order. */
export function prevNextFor(node: DocNode): { prev?: NavLink; next?: NavLink } {
  const i = NODES.findIndex((n) => n.route === node.route);
  const prevNode = i > 0 ? NODES[i - 1] : undefined;
  const nextNode = i >= 0 && i < NODES.length - 1 ? NODES[i + 1] : undefined;
  return {
    prev: prevNode ? { label: prevNode.title, href: prevNode.route } : undefined,
    next: nextNode ? { label: nextNode.title, href: nextNode.route } : undefined,
  };
}

/** Nodes grouped by package, in nav order — for landing/index listings. */
export function nodesByPackage(): { package: PackageId; label: string; nodes: DocNode[] }[] {
  return PACKAGE_ORDER.map((pkg) => ({
    package: pkg,
    label: PACKAGE_LABELS[pkg],
    nodes: NODES.filter((n) => n.package === pkg),
  }));
}
