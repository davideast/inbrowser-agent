# inbrowser docs site

Astro docs site for the inbrowser monorepo. Renders every package's
markdown under one Terminal Modernism design, with a sticky breadcrumb
bar for navigation (no left sidebar). The landing opens with a
**keystone**: a prompt box backed by a server-side agent that traverses
a content graph of the docs and answers, grounded, with links to the
real pages.

## Develop

```bash
bun run dev      # predev regenerates the content graph, then astro dev
```

Visit http://localhost:4321. Doc pages are static; the keystone needs
the agent backend (below).

## Agent backend (the keystone)

The `/api/ask` endpoint runs an `@inbrowser/agent` ReAct loop with
read-only graph tools, backed by a relay provider. The backend is
**switchable** via `DOCS_AGENT_PROVIDER`:

- **`gemini`** (default) — fast cloud Flash model. Needs `GEMINI_API_KEY`.
- **`ollama`** — local model, no key, no cost, but slower. Run
  `ollama serve` + `ollama pull qwen3:4b`.

Either way the LLM is reached server-side — the browser never holds the
key. Copy `.env.example` to `site/.env` and fill in:

| Var | Default | Purpose |
| --- | --- | --- |
| `DOCS_AGENT_PROVIDER` | `gemini` | `gemini` or `ollama`. |
| `GEMINI_API_KEY` | — | Required for `gemini`. [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `DOCS_AGENT_MODEL` | `gemini-3.5-flash` / `qwen3:4b` | Model override. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama endpoint (when `ollama`). |

## Build & deploy

```bash
bun run build    # prebuild regenerates the graph, then astro build
bun run preview
```

The site uses the **`@astrojs/node` standalone adapter** because
`/api/ask` is server-rendered. Doc pages still prerender to static HTML,
but the site as a whole must run as a Node server (not a pure static
CDN):

```bash
node ./dist/server/entry.mjs
```

The host must be able to reach `OLLAMA_BASE_URL`.

## Security note (public exposure)

`/api/ask` runs an unauthenticated agent loop against the local model. It
has a query-length cap and a global concurrency limit, but **do not
expose it publicly without auth** (e.g. Cloudflare Access or an
edge rate-limit) — an open endpoint is free, unauthenticated inference
and a DoS lever against the host. For demos, scope the tunnel and tear it
down afterward.

## Generated files

`src/generated/docs-graph.json` is produced by `scripts/build-graph.ts`
(run automatically by the `predev`/`prebuild` hooks) and is gitignored.
Run it directly with `bun run build-graph`.
