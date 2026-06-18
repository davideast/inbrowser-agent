/**
 * Read-only graph-traversal tools the docs agent calls to look things up
 * dynamically. Each returns a `ToolResult` whose `data` is JSON-serialized
 * back to the model as grounding (strategy.ts serializes the full result),
 * and whose shape also drives the keystone's nav cards.
 */
import { type ToolHandler, type ToolRegistry, createToolRegistry } from '@inbrowser/agent';
import { getNode, listDocs, listPackages, relatedDocs, searchDocs } from '../lib/graph';
import { hybridRetrieve } from '../lib/semantic-retrieval';

/** A search hit, shaped for `get_doc`, the Sources cards, and the
 *  retrieval strategy's `data.hits[].route` extractor. */
interface SearchHit {
  route: string;
  title: string;
  package: string;
  summary: string;
  score?: number;
}

/**
 * Hybrid (semantic + keyword) ranking, deduped to whole docs in rank order.
 * Pulls a generous chunk pool, keeps each route's first (best-ranked) chunk,
 * resolves it to its graph node, and returns the top `limit` distinct docs.
 * Falls back to plain keyword search if the embedder/index can't load so the
 * chat never hard-fails.
 */
async function hybridDocHits(query: string, limit: number): Promise<SearchHit[]> {
  try {
    const chunks = await hybridRetrieve(query, 12);
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const chunk of chunks) {
      if (seen.has(chunk.route)) continue;
      const node = getNode(chunk.route);
      if (!node) continue;
      seen.add(chunk.route);
      hits.push({
        route: node.route,
        title: node.title,
        package: node.package,
        summary: node.summary,
        score: hits.length + 1, // rank-derived (1 = best)
      });
      if (hits.length >= limit) break;
    }
    if (hits.length > 0) return hits;
  } catch {
    // Embedder/index failed to load — fall through to keyword search.
  }
  return searchDocs(query, limit).map((h) => ({
    route: h.route,
    title: h.title,
    package: h.package,
    summary: h.summary,
    score: h.score,
  }));
}

const list_packages: ToolHandler<Record<string, never>, unknown> = {
  name: 'list_packages',
  description:
    'List the documented packages (overview, agent, relay, resumable, model) with a one-line summary of each. Use this to orient before drilling in.',
  pure: true,
  parallelSafe: true,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() {
    const packages = listPackages();
    return {
      ok: true,
      summary: `Packages: ${packages.map((p) => `${p.label} (${p.count})`).join(', ')}`,
      data: { packages },
    };
  },
};

const list_docs: ToolHandler<{ package: string }, unknown> = {
  name: 'list_docs',
  description:
    'List the doc pages in a package. `package` is one of: overview, agent, relay, resumable, model.',
  pure: true,
  parallelSafe: true,
  parameters: {
    type: 'object',
    properties: { package: { type: 'string', description: 'Package id' } },
    required: ['package'],
    additionalProperties: false,
  },
  async execute({ package: pkg }) {
    const docs = listDocs(pkg);
    return {
      ok: true,
      summary: docs.length
        ? `${pkg}: ${docs.map((d) => d.title).join('; ')}`
        : `No docs for package "${pkg}".`,
      data: { docs },
    };
  },
};

const search_docs: ToolHandler<{ query: string }, unknown> = {
  name: 'search_docs',
  description:
    'Search all docs by meaning + keyword. Returns the best-matching pages (title, package, summary, route). Follow up with get_doc to read a page before answering.',
  pure: true,
  parallelSafe: true,
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What to search for' } },
    required: ['query'],
    additionalProperties: false,
  },
  async execute({ query }) {
    // Hybrid (semantic + keyword) ranking, deduped to whole docs; falls back
    // to keyword-only if the embedder can't load. Same return shape either way.
    const hits = await hybridDocHits(query, 5);
    return {
      ok: true,
      summary: hits.length
        ? `Top matches: ${hits.map((h) => `${h.title} (${h.route})`).join('; ')}`
        : `No matches for "${query}".`,
      data: { hits },
    };
  },
};

const get_doc: ToolHandler<{ route: string }, unknown> = {
  name: 'get_doc',
  description:
    'Read the full content of a doc page by its route (e.g. "/relay/reference"). Use this to ground your answer in the actual text before responding.',
  pure: true,
  parallelSafe: true,
  parameters: {
    type: 'object',
    properties: { route: { type: 'string', description: 'Doc route, e.g. /relay/reference' } },
    required: ['route'],
    additionalProperties: false,
  },
  async execute({ route }) {
    const node = getNode(route);
    if (!node) {
      return { ok: false, summary: `No doc at route "${route}". Use search_docs to find one.` };
    }
    // Cap the body fed back to the model — the strategy serializes the
    // whole result into the prompt each turn, and a small local model's
    // context can't hold several full doc bodies (qwen3:4b).
    const BODY_BUDGET = 4000;
    const truncated = node.body.length > BODY_BUDGET;
    const body = truncated ? `${node.body.slice(0, BODY_BUDGET)}\n\n[…truncated]` : node.body;
    return {
      ok: true,
      summary: `Opened ${node.title} (${node.route})${truncated ? ' [truncated]' : ''}`,
      data: {
        route: node.route,
        title: node.title,
        package: node.package,
        packageLabel: node.packageLabel,
        category: node.category,
        breadcrumb: node.breadcrumb,
        summary: node.summary,
        body,
      },
    };
  },
};

const related_docs: ToolHandler<{ route: string }, unknown> = {
  name: 'related_docs',
  description:
    'List docs related to a given route (cross-links and same-package siblings). Use to broaden context after reading a page.',
  pure: true,
  parallelSafe: true,
  parameters: {
    type: 'object',
    properties: { route: { type: 'string', description: 'Doc route to find neighbors of' } },
    required: ['route'],
    additionalProperties: false,
  },
  async execute({ route }) {
    const related = relatedDocs(route);
    return {
      ok: true,
      summary: related.length
        ? `Related to ${route}: ${related.map((r) => r.title).join('; ')}`
        : `No related docs for "${route}".`,
      data: { related },
    };
  },
};

/** Build a registry with all graph tools registered. */
export function createGraphToolRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  registry.register(list_packages);
  registry.register(list_docs);
  registry.register(search_docs);
  registry.register(get_doc);
  registry.register(related_docs);
  return registry;
}
