import type { Element, Root } from 'hast';
import { EXIT, visit } from 'unist-util-visit';

/**
 * Removes the first `<h1>` from each doc's rendered tree. The page title
 * is rendered by `PageHeader` (the single visible h1), so the source
 * markdown's leading h1 would otherwise be a duplicate in the DOM. We
 * strip it outright rather than hiding it with CSS, so there is exactly
 * one h1 in the document and the heading order starts cleanly at h2.
 */
export function rehypeStripFirstH1() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element, index, parent) => {
      if (node.tagName !== 'h1' || !parent || typeof index !== 'number') return;
      parent.children.splice(index, 1);
      return EXIT;
    });
  };
}
