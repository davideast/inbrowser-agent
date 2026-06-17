import path from 'node:path';
import type { Link, Root } from 'mdast';
import { SKIP, visit } from 'unist-util-visit';
import type { VFile } from 'vfile';

interface Options {
  /** Map of repo-root-relative source path (without `.md`) -> site route. */
  routeMap?: Record<string, string>;
  /** Absolute path to the repo root, for resolving links into a repo-relative id. */
  repoRoot?: string;
}

/**
 * Rewrites relative links between source docs to their real site routes.
 *
 * Docs live in scattered package directories and map to flat routes
 * (e.g. `packages/relay/docs/reference.md` -> `/relay/reference`). A
 * relative `.md` link is resolved against the current file's directory,
 * made repo-relative, and looked up in the graph's route map.
 *
 * - Resolved `.md` links are rewritten to the site route.
 * - Unresolved relative links (e.g. a README pointing at a docs tree that
 *   was never published) are unwrapped to plain text, so the site never
 *   ships a dead link. The link text is preserved.
 * - External URLs, in-page anchors, and absolute paths are left untouched.
 */
export function remarkRewriteLinks(options: Options = {}) {
  const routeMap = options.routeMap ?? {};
  const repoRoot = options.repoRoot ?? '';

  return (tree: Root, file: VFile) => {
    const filePath = file.path || file.history[0];

    visit(tree, 'link', (node: Link, index, parent) => {
      const raw = node.url;

      // Leave external, absolute, anchor-only, and protocol links alone.
      if (
        !raw ||
        raw.startsWith('http') ||
        raw.startsWith('/') ||
        raw.startsWith('#') ||
        raw.startsWith('mailto:')
      ) {
        return;
      }

      const [target, hash] = raw.split('#');

      // Resolve the target (a `.md`/`.mdx` file OR a directory) to a
      // known route. Make it repo-relative, then strip the extension
      // and any trailing slash to form the route-map key.
      const repoRel =
        filePath && repoRoot
          ? path.relative(repoRoot, path.resolve(path.dirname(filePath), target))
          : target;
      const key = repoRel.replace(/\.mdx?$/, '').replace(/\/$/, '');
      const route = routeMap[key];
      if (route) {
        node.url = hash ? `${route}#${hash}` : route;
        return;
      }

      // Unresolved relative link -> unwrap to its text content so no
      // dead link ships, and warn so the source gap is visible at build.
      console.warn(`[remark-rewrite-links] unresolved link "${raw}" in ${repoRel} — unwrapping`);
      if (parent && typeof index === 'number') {
        parent.children.splice(index, 1, ...node.children);
        return [SKIP, index];
      }
    });
  };
}
