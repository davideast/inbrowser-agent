# `@inbrowser/node`

Browser-isolated Node.js `22.18` container runtime for the `@inbrowser` monorepo.

## Architecture invariants

Read [docs/reference/architecture.md](docs/reference/architecture.md), [docs/guide/limits.md](docs/guide/limits.md), and [docs/reference/threat-model.md](docs/reference/threat-model.md) before changing runtime code.

- **Strict Worker boundaries** (enforced by `scripts/check-boundaries.mjs` on every `build`):
  - Only `src/kernel.ts` may import `memfs`. Guest processes never touch `memfs` directly; all VFS access crosses the syscall channel.
  - Browser runtime sources under `src/**` must never import `node:*` host modules or rely on a Node-host fallback.
  - `src/runtime.ts`, `src/service-worker.ts`, and `src/sandbox-host.ts` stay decoupled from guest-process internals.
- **Zero runtime npm dependencies**: `scripts/build.mjs` bundles browser shims and the 31 pure-JS files under `vendor/node-v22.18.0/lib/` into `dist/`, copies lazy WebAssembly sidecars (`sqlite.wasm`, `zlib-brotli.wasm`, `zlib-zstd.wasm`, `context-esbuild.wasm`), and generates `dist/THIRD_PARTY_NOTICES.txt`. Keep `dependencies` absent so consumer installs stay zero-bloat, and ensure `dist/types/**` emits zero bare imports to dev-only shim packages.
- **Lazy WASM cold boot**: Never compile or instantiate heavy WASM sidecars (`sqlite.wasm`, `zlib-brotli.wasm`, `zlib-zstd.wasm`, `context-esbuild.wasm`) during cold Worker boot; load them lazily on first module/codec use.
- **Honest boundaries**: Unsupported APIs fail explicitly with `ENOSYS` or Node-compatible error codes rather than silent no-ops. Do not claim untrusted-code isolation inside a single Worker realm; cross-origin isolation of host DOM/storage requires `SandboxContainer` + per-origin previews (`BootOptions.preview.origin`).

## Verification

```bash
bun run --cwd packages/node typecheck
bun run --cwd packages/node build
bun run --cwd packages/node test
PORT=4670 bun run --cwd packages/node test:e2e
```
