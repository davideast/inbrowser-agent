# Agent context for the `inbrowser` monorepo

## Repo shape

Seven packages under `packages/`:

- `@inbrowser/model` — shared `ModelClient` contract, cloud provider factories/adapters, and opt-in on-device LLM engine (`/local`). Independent; no internal deps.
- `@inbrowser/resumable` — pure resumable streaming-job engine. No internal deps.
- `@inbrowser/relay` — resumable LLM relay. Depends on `@inbrowser/resumable` and `@inbrowser/model`.
- `@inbrowser/workspace` — lightweight browser workspace runtime (OPFS/memory files, `esbuild-wasm` compile-and-mount preview, jailed shell, snapshots, local git, package import maps). Independent; no internal deps.
- `@inbrowser/sandbox` — binds workspace capabilities into agent-facing tools, chronological events, checkpoints, and artifacts. Depends on `@inbrowser/workspace`.
- `@inbrowser/node` — browser-isolated Node.js `22.18` container runtime (Web Worker kernel and guest processes, POSIX VFS over `SharedArrayBuffer` + `Atomics`, Service Worker HTTP/SSE/WebSocket preview, `node:sqlite`, WASM codecs, and 3-origin `SandboxContainer`). Independent; zero runtime npm dependencies.
- `@inbrowser/agent` — browser-safe agent runtime + Node CLI. Depends on `@inbrowser/model` and `@inbrowser/sandbox`.

## Conventions

- **Bun** for install / scripts / workspace orchestration. Workspaces are declared in the root `package.json`.
- **TypeScript** with shared `tsconfig.base.json`. Per-package `tsconfig.json` extends the base.
- **Biome** for lint + format. One tool; configured at the root (`biome.json`).
- **Pre-release.** No backwards-compat shims, no `Legacy*` aliases, no schemaVersion migrations. Pick the cleanest shape and update consumers in lockstep.
- **Skills** live in `.agents/skills/` at the repo root (dev-facing) and in `packages/<name>/skills/` (bundled into the npm artifact via the package's `files` field).

## Don't

- Don't add `.claude/skills/` symlinks.
- Don't write new packages without first checking whether the code belongs in one of the existing packages.
- Don't fold packages into another — each package boundary matches an explicit dependency and runtime isolation seam.

## Status

Pre-1.0. Packages publish independently under `@inbrowser/*` (`0.4.2` across `resumable`, `relay`, `workspace`, `sandbox`, `node`, `agent`; `0.5.0` on `model`).
