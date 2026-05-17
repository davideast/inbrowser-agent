#!/usr/bin/env bun
/**
 * Pack-and-import smoke test for `@inbrowser/{resumable,relay,agent}`.
 *
 * Per the extraction plan's Phase 3, this script:
 *   1. builds each package
 *   2. `npm pack`s each → tarball
 *   3. asserts tarball contents (no `src/`, no `tsconfig.json`, no tests;
 *      yes `dist/`, README, the agent's `bin/` + `skills/`)
 *   4. installs the three tarballs into a fresh scratch dir
 *   5. runs a `test.mjs` that imports a real entry from each package
 *      (root + a sub-export), verifying the published exports resolve
 *      and emit the expected values
 *   6. bundles `@inbrowser/relay/client/browser` for the `browser` target
 *      to prove the browser sub-export has no Node API references
 */

import { $ } from 'bun';
import { existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const PACK_OUT = mkdtempSync(join(tmpdir(), 'inbrowser-pack-'));
const SCRATCH = mkdtempSync(join(tmpdir(), 'inbrowser-smoke-'));

interface PackSpec {
  name: '@inbrowser/resumable' | '@inbrowser/relay' | '@inbrowser/agent';
  dir: string;
  /** Must appear in tarball. */
  expectFiles: string[];
  /** Must NOT appear in tarball. */
  forbidFiles: RegExp[];
}

const SPECS: PackSpec[] = [
  {
    name: '@inbrowser/resumable',
    dir: 'packages/resumable',
    expectFiles: ['package/dist/index.js', 'package/dist/index.d.ts', 'package/README.md'],
    forbidFiles: [/^package\/src\//, /^package\/test\//, /tsconfig\.json$/],
  },
  {
    name: '@inbrowser/relay',
    dir: 'packages/relay',
    expectFiles: [
      'package/dist/index.js',
      'package/dist/relay.js',
      'package/dist/sse.js',
      'package/dist/providers/gemini.js',
      'package/dist/providers/openrouter.js',
      'package/dist/providers/anthropic.js',
      'package/dist/adapters/astro.js',
      'package/dist/adapters/express.js',
      'package/dist/client/index.js',
      'package/dist/client/browser.js',
      'package/README.md',
    ],
    forbidFiles: [/^package\/src\//, /^package\/test\//, /tsconfig\.json$/],
  },
  {
    name: '@inbrowser/agent',
    dir: 'packages/agent',
    expectFiles: [
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/cli/index.js',
      'package/dist/node.js',
      'package/bin/agent.ts',
      'package/README.md',
      'package/AGENTS.md',
    ],
    forbidFiles: [/^package\/src\//, /^package\/test\//, /tsconfig\.json$/],
  },
];

let passed = 0;
let failed = 0;

function step(name: string): void {
  console.log(`\n━━━ ${name} ━━━`);
}

function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
  passed++;
}

function fail(msg: string): never {
  console.error(`  ✗ ${msg}`);
  failed++;
  throw new Error(msg);
}

async function build(): Promise<void> {
  step('build all packages');
  await $`bun run build`.cwd(ROOT);
  ok('bun run build');
}

async function pack(spec: PackSpec): Promise<string> {
  const pkgDir = join(ROOT, spec.dir);
  // `bun pm pack` rewrites `workspace:*` → resolved version; `npm pack`
  // does not, which makes the tarball uninstallable. `--quiet` prints
  // the tarball's full path as a single line.
  const out = await $`bun pm pack --destination ${PACK_OUT} --quiet`.cwd(pkgDir).text();
  return out.trim();
}

async function verifyTarball(spec: PackSpec, tarball: string): Promise<void> {
  step(`verify ${spec.name} tarball`);
  const contents = (await $`tar -tzf ${tarball}`.text()).split('\n').filter(Boolean);
  for (const expected of spec.expectFiles) {
    if (!contents.includes(expected)) fail(`missing in tarball: ${expected}`);
    ok(`contains ${expected}`);
  }
  for (const forbid of spec.forbidFiles) {
    const hits = contents.filter((c) => forbid.test(c));
    if (hits.length > 0) fail(`forbidden in tarball: ${forbid} (${hits.length} hits, e.g. ${hits[0]})`);
    ok(`no ${forbid}`);
  }
}

async function scratchInstall(tarballs: string[]): Promise<void> {
  step('scratch install');
  await $`npm init -y`.cwd(SCRATCH).quiet();
  // npm needs the tarballs by path; pass all three at once so peer
  // resolution sees them together.
  await $`npm install --silent --no-audit --no-fund ${tarballs}`.cwd(SCRATCH);
  ok(`installed ${tarballs.length} packages into ${SCRATCH}`);
}

async function importTest(): Promise<void> {
  step('import + invoke from scratch dir');
  const testFile = join(SCRATCH, 'test.mjs');
  await Bun.write(
    testFile,
    `
import assert from 'node:assert/strict';

// === @inbrowser/resumable ===
import { createMemoryJobStore } from '@inbrowser/resumable/memory';
const store = createMemoryJobStore();
assert.equal(typeof store.create, 'function');
assert.equal(typeof store.append, 'function');
console.log('  ✓ resumable: createMemoryJobStore wired');

// === @inbrowser/relay ===
import { createRelay, geminiProvider } from '@inbrowser/relay';
assert.equal(typeof createRelay, 'function');
assert.equal(typeof geminiProvider, 'function');
console.log('  ✓ relay: createRelay + geminiProvider exported');

// === @inbrowser/agent ===
import { createAgentSession, createToolRegistry, createReactLoopStrategy } from '@inbrowser/agent';
assert.equal(typeof createAgentSession, 'function');
assert.equal(typeof createToolRegistry, 'function');
assert.equal(typeof createReactLoopStrategy, 'function');
console.log('  ✓ agent: createAgentSession + tool registry + strategy exported');

// === sub-exports resolve ===
import * as agentCli from '@inbrowser/agent/cli';
assert.equal(typeof agentCli.main, 'function');
console.log('  ✓ agent/cli: main exported');

import * as agentNode from '@inbrowser/agent/node';
assert.equal(typeof agentNode.openEventLog, 'function');
console.log('  ✓ agent/node: openEventLog exported');
`,
  );
  await $`node test.mjs`.cwd(SCRATCH);
  ok('scratch dir import test passed');
}

async function browserBundle(): Promise<void> {
  step('browser-target bundle of @inbrowser/relay/client/browser');
  // The scratch dir already has @inbrowser/relay installed. Resolve
  // through node_modules so the test uses the *packed* output, not the
  // local source.
  const entry = join(SCRATCH, 'node_modules/@inbrowser/relay/dist/client/browser.js');
  if (!existsSync(entry)) fail(`browser entry missing: ${entry}`);
  const out = join(SCRATCH, 'browser-bundle');
  await $`bun build --target=browser --outdir=${out} ${entry}`.cwd(SCRATCH);
  ok(`bundled @inbrowser/relay/client/browser (output: ${out})`);
}

function showTarballSizes(): void {
  step('tarball sizes');
  for (const file of readdirSync(PACK_OUT)) {
    const path = join(PACK_OUT, file);
    const size = statSync(path).size;
    const kb = (size / 1024).toFixed(1);
    console.log(`  ${file.padEnd(40)} ${kb.padStart(8)} KB`);
  }
}

const KEEP_TMP = process.env['KEEP_TMP'] === '1';

try {
  await build();
  const tarballs: string[] = [];
  for (const spec of SPECS) {
    const tar = await pack(spec);
    tarballs.push(tar);
    await verifyTarball(spec, tar);
  }
  showTarballSizes();
  await scratchInstall(tarballs);
  await importTest();
  await browserBundle();
  console.log(`\n✓ smoke pack passed — ${passed} checks`);
} catch (err) {
  console.error(`\n✗ smoke pack failed: ${err instanceof Error ? err.message : String(err)}`);
  if (KEEP_TMP) {
    console.error(`  tarballs kept: ${PACK_OUT}`);
    console.error(`  scratch dir kept: ${SCRATCH}`);
  }
  process.exit(1);
} finally {
  if (!KEEP_TMP) {
    rmSync(PACK_OUT, { recursive: true, force: true });
    rmSync(SCRATCH, { recursive: true, force: true });
  } else {
    console.log(`\n(KEEP_TMP=1: tarballs at ${PACK_OUT}, scratch at ${SCRATCH})`);
  }
}
