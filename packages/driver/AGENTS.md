# AGENTS.md — `@inbrowser/driver`

## Purpose

`@inbrowser/driver` provides fast 1-RTT semantic browser UI observation, transactional multi-step actions, silent/GPU visual capture, and structured agent tool handlers (`ui_observe`, `ui_act`, `ui_capture`, opt-in `ui_eval`) across `<iframe>` previews, `MessagePort` channels, `@inbrowser/node` container previews, and real Chrome DevTools Protocol tabs (`puppeteer-core`).

## Architectural Boundaries

1. **Zero Core Runtime Dependencies:** `@inbrowser/driver` ships zero `dependencies`. Optional ecosystem integrations (`@inbrowser/node`, `@inbrowser/agent`, `@inbrowser/sandbox`, `puppeteer-core`) live strictly in optional `peerDependencies`.
2. **Self-Contained Preload (`<= 44 KiB` minified, `<= 16 KiB` gzipped):** `src/preload/entry.ts` compiles into a minified IIFE (`dist/preload.iife.js`) injected into guest frames. Modules under `src/preload/**` may only import sibling modules in `src/preload/` or pure leaf contracts (`src/types.ts`, `src/protocol.ts`), and must capture browser intrinsics in `src/preload/intrinsics.ts` before guest scripts run.
3. **Browser-Safe Core & Tools:** `src/index.ts`, `src/types.ts`, `src/protocol.ts`, `src/preload/**`, `src/host/**`, and `src/tools/**` must never import `node:*` modules or `puppeteer-core`. Only `src/puppeteer/**` may import `puppeteer-core`.
4. **Untrusted Wire Inputs:** Cross-origin `MessagePort` envelopes are untrusted inputs. Validate channel namespaces, protocol versions, message kinds, and payload shapes using runtime type guards (`unknown` -> narrowed types). Never use `any`; any `as` assertion other than `as const` requires an immediately preceding or same-line `// Invariant:` comment explaining why runtime narrowing cannot express it.
5. **Explicit Unsupported Seams:** Unimplemented capabilities throw a coded `DriverError` (`DRIVER_UNSUPPORTED` or `DRIVER_EVAL_DISABLED`) rather than returning silent fake success.
6. **Deterministic Resource Teardown:** Every pending operation requires an owner, timeout or `AbortSignal` path, and `dispose()` cleanup. Shut down fixture HTTP servers and Playwright resources inside `try / finally` blocks so zero ports or workers leak.

## Testing & Verification

- **Unit Tier (`bun run --cwd packages/driver test`):** Fast pure-TypeScript Vitest suites under `tests/unit/**/*.unit.test.ts` (protocol codecs, diffing, fingerprint matching, output formatting, compile-time ecosystem assignability).
- **Browser Acceptance Tier (`bun run test:e2e:driver`):** Real Chromium Playwright specs under `tests/*.spec.ts` against multi-origin HTTP fixtures (`DRIVER_TEST_PORT`, default `4700`) and the 3-origin `@inbrowser/node` `SandboxContainer` harness. Build `@inbrowser/node` and `@inbrowser/driver` before running E2E specs. Never substitute JSDOM or internal collaborator mocks for real browser behavior.
- **Boundary & Hygiene Gate (`bun run build:driver`):** Runs `scripts/build.mjs` (preload raw/gzip byte budgets, core/preload metafile graph checks, declaration emit with `types: []`, export target checks) followed by `scripts/check-boundaries.mjs` (AST import graph, `any`/bare-`as` invariant check, hygiene rules).
