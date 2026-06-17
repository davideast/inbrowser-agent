/**
 * Server-side accessors over the enriched content graph
 * (src/generated/docs-graph.json, produced by scripts/build-graph.ts).
 * These back the agent's graph-traversal tools and the keystone's
 * grounding. Keyword search only — no embeddings.
 */
import graphData from '../generated/docs-graph.json';

export interface GraphNode {
  id: string;
  package: string;
  packageLabel: string;
  category: string;
  categoryLabel: string;
  title: string;
  route: string;
  breadcrumb: string[];
  summary: string;
  body: string;
  related: string[];
}

interface GraphFile {
  nodeCount: number;
  packages: { id: string; label: string; routes: string[] }[];
  nodes: GraphNode[];
}

const graph = graphData as GraphFile;
const BY_ROUTE = new Map(graph.nodes.map((n) => [n.route, n]));

/** A lightweight node reference for listings + search results. */
export interface NodeRef {
  route: string;
  title: string;
  package: string;
  packageLabel: string;
  category: string;
  categoryLabel: string;
  breadcrumb: string[];
  summary: string;
}

function toRef(n: GraphNode): NodeRef {
  return {
    route: n.route,
    title: n.title,
    package: n.package,
    packageLabel: n.packageLabel,
    category: n.category,
    categoryLabel: n.categoryLabel,
    breadcrumb: n.breadcrumb,
    summary: n.summary,
  };
}

export function getNode(route: string): GraphNode | undefined {
  return BY_ROUTE.get(route);
}

export function listPackages(): { id: string; label: string; count: number; summary: string }[] {
  return graph.packages.map((p) => {
    const first = BY_ROUTE.get(p.routes[0] ?? '');
    return {
      id: p.id,
      label: p.label,
      count: p.routes.length,
      summary: first?.summary ?? '',
    };
  });
}

export function listDocs(pkg: string): NodeRef[] {
  return graph.nodes.filter((n) => n.package === pkg).map(toRef);
}

export function relatedDocs(route: string): NodeRef[] {
  const node = BY_ROUTE.get(route);
  if (!node) return [];
  return node.related
    .map((r) => BY_ROUTE.get(r))
    .filter((n): n is GraphNode => !!n)
    .map(toRef);
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'is',
  'it',
  'how',
  'do',
  'i',
  'my',
  'and',
  'or',
  'for',
  'with',
  'what',
  'why',
  'when',
  'can',
  'does',
  'use',
  'using',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Keyword search over title (weighted), summary, and body. Returns the
 * top matches as lightweight refs, best first.
 */
export function searchDocs(query: string, limit = 5): (NodeRef & { score: number })[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const scored = graph.nodes.map((n) => {
    const title = n.title.toLowerCase();
    const summary = n.summary.toLowerCase();
    const body = n.body.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 5;
      if (summary.includes(t)) score += 3;
      // Count whole-word body occurrences (capped) so one long doc can't
      // dominate and "model" doesn't match "modeling"/"remodeled".
      const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      const hits = (body.match(re) ?? []).length;
      score += Math.min(hits, 4);
    }
    return { node: n, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({ ...toRef(s.node), score: s.score }));
}
