/**
 * Astro adapter — Astro already hands you Web-standard
 * `Request`/`Response`, so the adapter is almost nothing. The value
 * is the route-pair convention.
 *
 * Wire-up:
 *
 *   // src/server/relay.ts
 *   import { createRelay } from '@inbrowser/relay';
 *   import { createAstroRoutes } from '@inbrowser/relay/adapters/astro';
 *   import { geminiProvider } from '@inbrowser/relay/providers/gemini';
 *
 *   const relay = createRelay({ store, providers: { gemini: geminiProvider } });
 *   export const { start, stream } = createAstroRoutes(relay);
 *
 *   // src/pages/api/inference/job.ts
 *   export { start as POST } from '~/server/relay';
 *
 *   // src/pages/api/inference/job/[id]/stream.ts
 *   export { stream as GET } from '~/server/relay';
 */
import type { Relay } from '../relay';

/** The shape Astro's APIRoute uses — narrowed so we don't have to
 *  declare a hard dependency on the `astro` package's types. */
type AstroLikeContext = {
  request: Request;
  params: Record<string, string | undefined>;
};

type AstroLikeRoute = (
  context: AstroLikeContext,
) => Response | Promise<Response>;

export interface AstroRoutes {
  /** Plug into `src/pages/api/inference/job.ts` as `export const POST`. */
  start: AstroLikeRoute;
  /**
   * Plug into `src/pages/api/inference/job/[id]/stream.ts` as
   * `export const GET`. Reads the job id from `params.id`.
   */
  stream: AstroLikeRoute;
}

export interface CreateAstroRoutesOpts {
  /**
   * Name of the dynamic route segment holding the job id. Default
   * `id`, matching `[id]` in the path.
   */
  jobIdParam?: string;
}

export function createAstroRoutes(
  relay: Relay,
  opts: CreateAstroRoutesOpts = {},
): AstroRoutes {
  const jobIdParam = opts.jobIdParam ?? 'id';
  return {
    start: ({ request }: AstroLikeContext) => relay.handleStart(request),
    stream: ({ request, params }: AstroLikeContext) =>
      relay.handleStream(request, { jobId: params[jobIdParam] ?? '' }),
  };
}
