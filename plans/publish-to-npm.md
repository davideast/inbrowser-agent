# Publish `@inbrowser/*` to npm

Status: planning. Pre-1.0. Four packages. Existing npm presence:
`@inbrowser/{resumable,relay,agent}` are already published at `0.1.0`;
`@inbrowser/model` has never been published.

## 1. Inventory

| Package | local `version` | on npm | dist size (tgz) | ships |
|---|---|---|---|---|
| `@inbrowser/resumable` | 0.2.0 | 0.1.0 | 32.8 KB | `dist/`, `README.md`, `docs/` |
| `@inbrowser/relay` | 0.2.0 | 0.1.0 | 38.4 KB | `dist/`, `README.md`, `docs/` |
| `@inbrowser/agent` | 0.2.0 | 0.1.0 (also a 0.0.0-placeholder) | 213.3 KB | `dist/`, `bin/`, `skills/`, `AGENTS.md`, `README.md` |
| `@inbrowser/model` | 0.1.0 | not published | 17.8 KB | `dist/`, `README.md`, `AGENTS.md` |

Sizes from `bun pm pack` on a clean build.

Dep graph (from `AGENTS.md` + `README.md` + `package.json`s):

```
@inbrowser/resumable    no internal deps
        ↑
@inbrowser/relay        deps: @inbrowser/resumable  (workspace:*)
                        peers (optional): astro, express

@inbrowser/agent        no internal deps
                        deps: @modelcontextprotocol/sdk, @opentui/*, react

@inbrowser/model        no internal runtime deps
                        peers (required): @huggingface/transformers
                        peers (optional): @inbrowser/agent, @inbrowser/relay
                          — used by /agent and /relay subpath adapters
```

## 2. Pre-flight gaps

### 2a. `workspace:*` resolution depends on a stale lockfile

`bun pm pack` rewrites `workspace:*` using **`bun.lock`**, not the local
`package.json#version`. The lockfile in this worktree still pins
`@inbrowser/resumable` at `0.1.0` because no `bun install` has been run
since the version bump commit `fae8e87` ("chore(release): bump
@inbrowser/{agent,resumable,relay} to 0.2.0").

Concrete evidence:

```bash
bun pm pack --destination /tmp/x --cwd packages/relay
# Produces inbrowser-relay-0.2.0.tgz containing:
#   "dependencies": { "@inbrowser/resumable": "0.1.0" }   ← wrong, should be 0.2.0
```

Same issue for `packages/model/package.json`'s peer/devDeps on
`@inbrowser/{agent,relay}` — they pack as `0.1.0` because the lockfile is
the source of truth.

**Fix:** `bun install` before pack/publish. Verify by re-packing and
inspecting the tarball's `package.json`.

### 2b. No `LICENSE` file in repo

Every `package.json` has `"license": "MIT"` but no `LICENSE*` files
exist (root or per-package). npm doesn't reject this, but the generated
registry page shows "no license file." Either:

- add a root `LICENSE` (MIT) and reference per-package via `files`, **or**
- add per-package `LICENSE` copies (npm auto-includes `LICENSE` even when
  not in `files`).

### 2c. `agent`'s `bin` is a `.ts` file

```json
"bin": { "agent": "./bin/agent.ts" }
```

`bin/agent.ts` starts with `#!/usr/bin/env bun`. The CLI runs **only**
when the user has `bun` on PATH. Document this in `packages/agent/README.md`
under installation. Alternative (deferred — not blocking 0.2.0): compile
`bin/agent.ts` → `dist/bin/agent.js` with a node shebang and switch the
`bin` field. The current model is consistent with `AGENTS.md`'s
"Bun for install / scripts / tests" stance, so leave it.

### 2d. Repo dot-files

All four `package.json`s already have:

- `repository.type` + `repository.url` + `repository.directory`
- `license: "MIT"`
- `description` (long, accurate)

Missing on all four:

- `homepage` (e.g., `https://github.com/davideast/inbrowser-agent#readme`)
- `bugs` (e.g., `https://github.com/davideast/inbrowser-agent/issues`)
- `author` / `contributors`
- `keywords`

These are not publish blockers but improve discoverability. Add in a
follow-up patch before the first 1.0.

### 2e. `files` field shape

| Package | `files` value | observed gaps |
|---|---|---|
| resumable | `["dist", "README.md", "docs"]` | OK |
| relay | `["dist", "README.md", "docs"]` | OK |
| agent | `["dist", "bin", "skills", "AGENTS.md", "README.md"]` | OK; `bin/agent.ts` is shipped as TS by design |
| model | `["dist", "README.md", "AGENTS.md"]` | No `docs/` — confirmed model has no `docs/` dir, so OK |

No source/test leakage observed in the smoke test (regexes
`/^package\/src\//`, `/^package\/test\//`, `tsconfig.json` all pass).

### 2f. Smoke coverage gaps

`scripts/smoke-pack.ts` currently:

- covers `@inbrowser/{resumable,relay,agent}` — **not `@inbrowser/model`**
- `relay` `expectFiles` list omits `dist/providers/ollama.js`, which is
  in the dist tree and listed in `exports` (`./providers/ollama`).
  Today's smoke would still pass because the regex `forbidFiles` doesn't
  hit it, but ollama is not asserted-present.
- expects `package/dist/relay.js` (a re-export shim) — present in build
  output, good.

Before publish, extend smoke-pack with a fourth `PackSpec` for
`@inbrowser/model` and add the ollama line to relay's `expectFiles`.
The model spec needs `expectFiles` like:

```
package/dist/index.js
package/dist/presets.js
package/dist/adapters/relay.js
package/dist/adapters/agent.js
package/dist/worker.js
package/README.md
```

…and a `test.mjs` block that imports `@inbrowser/model` and
`@inbrowser/model/presets`. Note: cannot easily exercise
`createEngine()` in node — it pulls in `@huggingface/transformers`. The
smoke test should import only and assert the export shape.

### 2g. Declaration maps reference paths not shipped

`packages/resumable/dist/index.d.ts.map` (and every `.d.ts.map`) contains:

```
"sources":["../src/index.ts"]
```

`src/` is not in any package's `files`. Maps will dangle. Two options:

1. Drop `declarationMap` / `sourceMap` from the per-package `tsconfig.json`
   for publish builds. Cleanest.
2. Add `src` to `files` so the maps resolve. Adds ~20–40 KB per package
   and exposes the source. Not preferred.

This is **cosmetic** for users; no install or import failure. Defer to a
follow-up, but track it.

### 2h. `model`'s `devDependencies` pin `@inbrowser/{relay,agent}` as `workspace:*`

After `bun install`, those rewrite to `0.2.0` in the packed tarball.
That's fine — npm ignores `devDependencies` at install time. No action.

## 3. Build verification

`bun run build` succeeds locally. Per-package dist trees:

- **resumable**: 36 files (9 .js, 9 .d.ts, 9 .js.map, 9 .d.ts.map).
  Entries: `index`, `engine`, `ids`, `testing`, `types`,
  `store/{contract,memory}`, `store/rtdb/{auth,index,rest}`.
- **relay**: 44 files. Entries: `index`, `relay`, `sse`, `types`,
  `providers/{gemini,openrouter,anthropic,ollama}`,
  `adapters/{astro,express}`, `client/{index,browser}`.
- **agent**: by far the largest. ~70 source files compile to a `dist/`
  tree mirroring `src/`: `cli/`, `cli/commands/`, `cli/ui/`,
  `diagnostics/`, `eval/`, `events/`, `mcp/`, `metrics/`, `types/`,
  plus top-level `session`, `strategy`, `tools`, `storage`,
  `llm-adapter`, `metrics`, `planner-executor`, `skill-catalog`,
  `skill-router`, `node`, `index`.
- **model**: 9 .js files. Entries: `index`, `engine`, `presets`,
  `types`, `worker`, `adapters/{agent,relay}`.

Verify each package's `exports` map every claimed subpath to a real
`dist/*.js`:

- resumable: `.`, `./memory`, `./rtdb`, `./testing` — all resolve.
- relay: `.`, `./sse`, `./providers/{gemini,openrouter,anthropic,ollama}`,
  `./adapters/{astro,express}`, `./client`, `./client/browser` — all
  resolve (10 subpaths total).
- agent: `.`, `./cli`, `./node` — all resolve. `bin/agent` is a
  separate `bin` entry.
- model: `.`, `./presets`, `./relay`, `./agent`, `./worker` — all
  resolve.

No `exports` entry points at `src/`. Good.

## 4. Publish order

Independent → dependent:

1. **`@inbrowser/resumable`** (no internal deps)
2. **`@inbrowser/relay`** (depends on resumable — must wait for step 1 to
   appear on registry, or pre-resolve the version pin)
3. **`@inbrowser/agent`** (independent — can publish in parallel with
   relay)
4. **`@inbrowser/model`** (optional peer deps on relay/agent; required
   peer on `@huggingface/transformers`. Publish last so the optional
   peers are already on the registry at the matching version.)

Between each `npm publish`, wait ~30s for the registry to propagate
before the next package tries to resolve it as a peer. (Not strictly
necessary because npm doesn't resolve peers at publish time, but useful
when running the smoke test against the registry after.)

## 5. Versioning policy

Current state: resumable=relay=agent at `0.2.0`, model at `0.1.0`.

Options:

- **(A) Bump model to 0.2.0 to align all four.** Pro: lockstep, one
  version is the answer to "what version of inbrowser am I using?". Con:
  model is a POC and on a different maturity curve.
- **(B) Keep model at 0.1.0; let model evolve independently.** Pro:
  honest about POC status. Con: cross-package compatibility matrix gets
  fuzzy.

**Recommendation:** **(B) for now.** `AGENTS.md` calls model out as
"(POC)". Document the compatibility matrix in `packages/model/README.md`
as a single-line "tested against `@inbrowser/relay@^0.2.0` /
`@inbrowser/agent@^0.2.0`" and pin the optional peer ranges accordingly.

Going forward (pre-1.0):

- Treat **resumable, relay, agent** as a lockstep group. Bump together,
  publish together. They share the cross-package contract used by the
  smoke test.
- Treat **model** as independent until its API stabilizes. Each model
  publish must run the smoke test against the *currently latest*
  published relay/agent.

After 1.0: independent semver per package; cross-package breaking
changes go in coordinated major bumps.

## 6. `npm publish` mechanics

### Tool choice

Two viable tools:

- **`npm publish`** (canonical). Does **not** rewrite `workspace:*` →
  fails for relay and model unless we manually re-pin. Don't use
  directly.
- **`bun publish`** / **`bun pm pack`** (used today by smoke). Rewrites
  `workspace:*` using `bun.lock`. Works *if* lockfile is fresh.

**Recommended flow:** `bun pm pack` → inspect tarball → `npm publish
<tarball>`. This decouples the workspace-rewriting step (bun) from the
registry upload step (npm), and lets us inspect what's actually being
published before the upload.

### Per-package commands

For each of the four packages, in publish order:

```bash
# from repo root
bun install                              # refresh lockfile (critical)
bun run build                            # ensure dist/ is current
bun run smoke                            # gate: extended to cover model

cd packages/<name>
bun pm pack --destination /tmp/pub --quiet
# manually inspect the tarball:
tar -xOf /tmp/pub/inbrowser-<name>-<version>.tgz package/package.json | jq

# dry-run first
npm publish /tmp/pub/inbrowser-<name>-<version>.tgz \
  --access public \
  --dry-run

# real publish (will prompt for 2FA OTP if account requires it)
npm publish /tmp/pub/inbrowser-<name>-<version>.tgz \
  --access public \
  --otp <code>
```

`--access public` is **required** for scoped packages on the free tier.
The repo's `.npmrc` already sets `access=public` globally — that suffices,
but pass the flag explicitly for clarity.

### Auth

Unknown — needs check by maintainer. Run `npm whoami`. If unauthenticated,
`npm login` (or set `NPM_TOKEN` env var for CI). The existing 0.1.0
publishes prove *some* account has rights to the `@inbrowser/` scope —
verify the maintainer still has that account's credentials before
attempting 0.2.0.

## 7. Tag strategy

Default tag on `npm publish` is `latest`. For pre-1.0, three options:

- **Publish to `latest`** (current default; both 0.1.0 publishes went
  here per `npm view @inbrowser/agent dist-tags`). Fine pre-1.0 because
  the version itself (`0.x`) communicates "expect breakage."
- **Publish to `next` and let users explicitly opt in.** Heavier
  ceremony. Justified only if `0.x → 0.y` regularly breaks consumers.
- **Pre-release suffixes** (`0.2.0-alpha.0`, `0.2.0-rc.1`). Useful for
  staging a publish before committing. Publish with `--tag next` and
  promote via `npm dist-tag add @inbrowser/relay@0.2.0 latest`.

**Recommendation:**

- For `0.2.0` of `{resumable,relay,agent}`: publish to `latest`. The
  packages are stable enough — the smoke test passes — and existing
  users at 0.1.0 should get the upgrade.
- For first publish of `@inbrowser/model@0.1.0`: publish to `latest`
  (it's the only version, no other choice meaningful).
- For future model versions while still POC: consider `--tag next`
  until the worker subpath stabilizes.

## 8. Automated vs manual

`.github/workflows/ci.yml` today runs `check + build + test + smoke` on
PRs and pushes to `main`. Green CI is the necessary precondition for any
publish, but CI does not currently publish.

**For now (0.2.0):** publish manually.

- Cut a release branch (or use main after the version PR merges).
- Run the publish locally with the steps in §6.
- After all four are on the registry, create a GitHub release manually:
  `gh release create v0.2.0 --notes "..."`. One umbrella release for
  the lockstep three; a separate `model-v0.1.0` tag/release for model.

**Later (when worth the cost):** add a `release.yml` workflow triggered
on tag push (`v*`) that:

1. Checks out the tag
2. `bun install --frozen-lockfile && bun run build && bun run smoke`
3. For each package, packs and publishes using `NPM_TOKEN` from secrets
4. Creates the GitHub release

Prior art in `.github/workflows/`: only `ci.yml`. No existing release
automation. Build on the same `oven-sh/setup-bun@v2` runner pattern.

## 9. Pre-publish checklist

Run through this in order, every publish, no exceptions.

- [ ] On the right branch, working tree clean (`git status`).
- [ ] Versions in `packages/*/package.json` reflect what's being shipped.
- [ ] `bun install` — lockfile in sync, no diff in `bun.lock` after.
      Verify the workspace pins:
      `grep '"version"' bun.lock | head -20` — check that
      `@inbrowser/{resumable,relay,agent}` entries match
      `packages/*/package.json#version`.
- [ ] `bun run check` — biome clean.
- [ ] `bun run typecheck` — all four packages.
- [ ] `bun run build` — all four packages.
- [ ] `bun run test` — all four packages.
- [ ] `bun run smoke` — extended to cover `@inbrowser/model` and
      `@inbrowser/relay/providers/ollama` (see §2f).
- [ ] `npm whoami` returns the right account.
- [ ] For each package, in order — resumable, agent, relay, model:
  - [ ] `bun pm pack --destination /tmp/pub --cwd packages/<name>`
  - [ ] Inspect tarball's `package.json`:
        `tar -xOf /tmp/pub/inbrowser-<name>-<ver>.tgz package/package.json`
        — verify no `workspace:*` strings, internal deps pin matches
        what's about to be published.
  - [ ] `npm publish /tmp/pub/inbrowser-<name>-<ver>.tgz --access public
        --dry-run`
  - [ ] `npm publish /tmp/pub/inbrowser-<name>-<ver>.tgz --access public
        --otp <code>`
  - [ ] `npm view @inbrowser/<name>@<ver>` — confirm registry sees it.
- [ ] After all four are live, run the smoke test against the registry:
      `cd /tmp/scratch && npm init -y && npm i @inbrowser/{resumable,relay,agent,model}@latest`
      then `node -e "import('@inbrowser/relay').then(m => console.log(typeof m.createRelay))"`.
- [ ] Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
- [ ] `gh release create v0.2.0 --generate-notes`.

## 10. Rollback plan

### Publish-day errors (within 72h)

npm's unpublish window for non-deprecated, no-dependents packages is
72 hours. Inside that window:

```bash
npm unpublish @inbrowser/<name>@<bad-version>
```

Then fix the issue and publish a **new patch** (e.g. `0.2.1`). Do **not**
republish the same version — even after unpublish, npm caches the
checksum for 24 hours and the same version cannot be re-uploaded.

### After 72h or with dependents

Cannot unpublish. Options:

1. **Deprecate** the bad version:
   ```bash
   npm deprecate @inbrowser/<name>@<bad-version> \
     "Broken — use <good-version>"
   ```
   Users get a warning on install. Existing pinned installs keep working.

2. **Publish a patch** with the fix. Bump `0.2.0 → 0.2.1`. This is the
   primary recovery path.

3. **Update dist-tag**:
   `npm dist-tag add @inbrowser/<name>@<good-version> latest` to swing
   the default install target back to a known-good version.

### Worst case: broken cross-package compatibility

If `@inbrowser/relay@0.2.0` ships but its
`@inbrowser/resumable` dep pin is wrong (e.g., `0.1.0` from a stale
lockfile — see §2a), users get an install that *resolves* but at runtime
fails because the relay code was compiled against the 0.2.0 resumable
API. Recovery:

- Publish `relay@0.2.1` with the correct pin.
- Deprecate `relay@0.2.0` pointing at `0.2.1`.
- Do **not** unpublish relay@0.2.0 because resumable@0.2.0 already
  depends on the build artifact being on the registry for the smoke
  test trail.

## Appendix: open questions

- **npm auth state.** Unknown — needs check by maintainer. Run
  `npm whoami`. The 0.1.0 publishes happened, so some account on this
  machine or another had rights to the `@inbrowser/` scope.
- **2FA on the npm account.** Unknown — needs check by maintainer. Run
  `npm profile get` and look at `tfa`. If enabled, every publish needs
  `--otp <code>`.
- **`bun publish` viability for this workspace.** `bun pm pack` is
  known-good (used in smoke). `bun publish` directly is untested here —
  recommend the pack-then-`npm publish` path until proven otherwise.
- **Whether to add `@inbrowser/model` to the smoke test now or after
  first publish.** Recommend: now. Cheap to add a fourth `PackSpec`,
  prevents publishing an unverifiable artifact.
