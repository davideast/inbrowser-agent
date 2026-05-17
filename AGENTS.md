# Agent context for the `inbrowser` monorepo

## Repo shape

Three packages under `packages/`:

- `@inbrowser/agent` — runtime + CLI. Independent; no internal deps on the other two.
- `@inbrowser/relay` — resumable LLM relay. Depends on `@inbrowser/resumable`.
- `@inbrowser/resumable` — pure streaming-job engine. No internal deps.

## Conventions

- **Bun** for install / scripts / tests. Workspaces are declared in the root `package.json`.
- **TypeScript** with shared `tsconfig.base.json`. Per-package `tsconfig.json` extends the base.
- **Biome** for lint + format. One tool; configured at the root.
- **Pre-release.** No backwards-compat shims, no `Legacy*` aliases, no schemaVersion migrations. Pick the cleanest shape and update consumers in lockstep.
- **Skills** live in `.agents/skills/` at the repo root (dev-facing) and in `packages/<name>/skills/` (bundled into the npm artifact via the package's `files` field).

## Don't

- Don't add `.claude/skills/` symlinks.
- Don't write new packages without first checking whether the code belongs in one of the existing three.
- Don't fold any of the three packages into another — the boundary was chosen to match the actual import graph.

## Status

Pre-1.0. First publish: `0.1.0`. Versions across the three packages are coordinated manually for now.
