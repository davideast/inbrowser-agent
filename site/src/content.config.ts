import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * Loads the existing package markdown from across the monorepo. The
 * source files have no frontmatter — all display metadata lives in
 * `src/content/graph.ts` and is joined to these entries by id.
 *
 * `generateId` returns the repo-root-relative path without `.md`
 * (case + slashes preserved) so entry ids match `entryIdOf(node)`
 * exactly. The glob may over-collect (e.g. docs hub READMEs); the
 * router only renders nodes that exist in the graph.
 */
const docs = defineCollection({
  loader: glob({
    base: '..',
    pattern: [
      'README.md',
      'AGENTS.md',
      'packages/*/README.md',
      'packages/*/AGENTS.md',
      'packages/*/docs/*.md',
      'packages/*/skills/*.md',
    ],
    generateId: ({ entry }) => entry.replace(/\.md$/, ''),
  }),
  schema: z.object({}),
});

export const collections = { docs };
