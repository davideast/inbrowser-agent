/**
 * Build the enriched content graph consumed by the server-side docs
 * agent (Phase 2). Starts from the Phase 1 hierarchy graph (NODES) and
 * adds, per node: the markdown body, the breadcrumb label trail, and a
 * `related` adjacency set (cross-doc links + same-package siblings).
 *
 * Emits src/generated/docs-graph.json. Run via the `predev`/`prebuild`
 * hooks so dev and build always have a fresh graph.
 *
 *   bun run scripts/build-graph.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CATEGORY_LABELS,
  NODES,
  PACKAGE_LABELS,
  PACKAGE_ORDER,
  breadcrumbFor,
  buildRouteMap,
  entryIdOf,
} from '../src/content/graph';

const siteDir = path.resolve(import.meta.dir, '..');
const repoRoot = path.resolve(siteDir, '..');
const routeMap = buildRouteMap();

/** Strip a single leading H1 line — the title is carried separately. */
function stripLeadingH1(md: string): string {
  return md.replace(/^\s*#\s+.*(\r?\n)+/, '');
}

/** Resolve a markdown link target (relative to the doc's dir) to a node
 *  route, or null if it isn't an internal doc link. */
function resolveLink(sourcePath: string, target: string): string | null {
  if (
    !target ||
    target.startsWith('http') ||
    target.startsWith('/') ||
    target.startsWith('#') ||
    target.startsWith('mailto:')
  ) {
    return null;
  }
  const [bare] = target.split('#');
  const fromDir = path.dirname(sourcePath);
  const repoRel = path.normalize(path.join(fromDir, bare));
  const key = repoRel.replace(/\.mdx?$/, '').replace(/\/$/, '');
  return routeMap[key] ?? null;
}

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Extract resolvable internal-link target routes from markdown. */
function extractLinks(sourcePath: string, md: string): string[] {
  const out = new Set<string>();
  for (const m of md.matchAll(LINK_RE)) {
    const route = resolveLink(sourcePath, m[1]!);
    if (route) out.add(route);
  }
  return [...out];
}

interface GraphNode {
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

// First pass: read bodies + outgoing links.
const linksOut = new Map<string, string[]>();
const partial: Omit<GraphNode, 'related'>[] = NODES.map((node) => {
  const raw = readFileSync(path.join(repoRoot, node.sourcePath), 'utf8');
  const body = stripLeadingH1(raw).trim();
  linksOut.set(node.route, extractLinks(node.sourcePath, raw));
  return {
    id: node.route,
    package: node.package,
    packageLabel: PACKAGE_LABELS[node.package],
    category: node.category,
    categoryLabel: CATEGORY_LABELS[node.category],
    title: node.title,
    route: node.route,
    breadcrumb: breadcrumbFor(node).map((c) => c.label),
    summary: node.summary,
    body,
  };
});

// Reverse index for incoming links.
const linksIn = new Map<string, Set<string>>();
for (const [from, tos] of linksOut) {
  for (const to of tos) {
    if (!linksIn.has(to)) linksIn.set(to, new Set());
    linksIn.get(to)!.add(from);
  }
}

// Second pass: related = links (both directions) + same-package siblings.
const nodes: GraphNode[] = partial.map((n) => {
  const related = new Set<string>();
  for (const r of linksOut.get(n.route) ?? []) related.add(r);
  for (const r of linksIn.get(n.route) ?? []) related.add(r);
  for (const sib of NODES) {
    if (sib.package === n.package && sib.route !== n.route) related.add(sib.route);
  }
  related.delete(n.route);
  return { ...n, related: [...related] };
});

const out = {
  nodeCount: nodes.length,
  packages: PACKAGE_ORDER.map((pkg) => ({
    id: pkg,
    label: PACKAGE_LABELS[pkg],
    routes: nodes.filter((n) => n.package === pkg).map((n) => n.route),
  })),
  nodes,
};

const outDir = path.join(siteDir, 'src/generated');
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'docs-graph.json');
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);

// Sanity: every node has a non-empty body, and entry ids are consistent.
const empties = nodes.filter((n) => n.body.length < 20).map((n) => n.route);
for (const node of NODES) void entryIdOf(node);
console.log(
  `[build-graph] wrote ${nodes.length} nodes -> ${path.relative(siteDir, outPath)}` +
    (empties.length ? ` (WARNING empty bodies: ${empties.join(', ')})` : ''),
);
