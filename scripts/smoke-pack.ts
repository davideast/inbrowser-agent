#!/usr/bin/env bun
/**
 * Pack-and-import smoke test for the published `@inbrowser/*` packages.
 *
 * Per the extraction plan's Phase 3 (extended to cover model when the
 * package landed), this script:
 *   1. builds each package
 *   2. `npm pack`s each → tarball
 *   3. asserts tarball contents (no `src/`, no `tsconfig.json`, no tests;
 *      yes `dist/`, README, the agent's `bin/` + `skills/`, model's
 *      `adapters/` and `worker.js`, etc.)
 *   4. installs all tarballs into a fresh scratch dir
 *   5. runs a `test.mjs` that imports a real entry from each package
 *      (root + sub-exports), verifying the published exports resolve
 *      and emit the expected values
 *   6. bundles `@inbrowser/relay/client/browser` for the `browser` target
 *      to prove the browser sub-export has no Node API references
 *
 * The on-device model coverage is import-only because `createEngine`
 * needs a real model. Constructed-runtime adapters are invoked with
 * structural fakes so their packed root exports and dependency seams
 * are exercised.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { $ } from 'bun';

const ROOT = resolve(import.meta.dir, '..');
const PACK_OUT = mkdtempSync(join(tmpdir(), 'inbrowser-pack-'));
const SCRATCH = mkdtempSync(join(tmpdir(), 'inbrowser-smoke-'));

interface PackSpec {
  name:
    | '@inbrowser/resumable'
    | '@inbrowser/relay'
    | '@inbrowser/workspace'
    | '@inbrowser/sandbox'
    | '@inbrowser/agent'
    | '@inbrowser/model';
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
    expectFiles: [
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/README.md',
      'package/dist/http.js',
      'package/dist/client.js',
    ],
    forbidFiles: [/^package\/src\//, /^package\/test\//, /tsconfig\.json$/],
  },
  {
    name: '@inbrowser/relay',
    dir: 'packages/relay',
    expectFiles: [
      'package/dist/index.js',
      'package/dist/relay.js',
      'package/dist/sse.js',
      // Providers moved to @inbrowser/model (stage 4) — relay no longer
      // ships them; the `forbidFiles` rule below pins that.
      'package/dist/adapters/astro.js',
      'package/dist/adapters/express.js',
      'package/dist/client/index.js',
      'package/dist/client/browser.js',
      'package/README.md',
    ],
    // ...plus no relay-side providers/ dir (clean break, stage 4).
    forbidFiles: [
      /^package\/src\//,
      /^package\/test\//,
      /tsconfig\.json$/,
      /^package\/dist\/providers\//,
    ],
  },
  {
    name: '@inbrowser/workspace',
    dir: 'packages/workspace',
    expectFiles: [
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/fs/index.js',
      'package/dist/preview/index.js',
      'package/dist/preview/react.js',
      'package/dist/shell/index.js',
      'package/dist/git/index.js',
      'package/dist/packages/index.js',
      'package/README.md',
      'package/AGENTS.md',
    ],
    forbidFiles: [/^package\/src\//, /^package\/test\//, /tsconfig\.json$/],
  },
  {
    name: '@inbrowser/sandbox',
    dir: 'packages/sandbox',
    expectFiles: [
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/README.md',
      'package/AGENTS.md',
      'package/docs/overview.md',
      'package/docs/how-to-wire-an-agent.md',
      'package/docs/reference.md',
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
      'package/dist/sandbox/index.js',
      'package/bin/agent.ts',
      'package/README.md',
      'package/AGENTS.md',
    ],
    forbidFiles: [/^package\/src\//, /^package\/test\//, /tsconfig\.json$/],
  },
  {
    name: '@inbrowser/model',
    dir: 'packages/model',
    expectFiles: [
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/contract.js',
      'package/dist/contract.d.ts',
      'package/dist/engine-client.js',
      'package/dist/presets.js',
      'package/dist/worker.js',
      'package/dist/think.js',
      'package/dist/parse-tool-calls.js',
      // The cloud provider factories + the retry decorator now live here
      // (stage 4).
      'package/dist/with-retry.js',
      'package/dist/providers/gemini.js',
      'package/dist/providers/gemini-protocol.js',
      'package/dist/providers/firebase-ai-logic.js',
      'package/dist/providers/openrouter.js',
      'package/dist/providers/anthropic.js',
      'package/dist/providers/oai-compat.js',
      'package/dist/providers/ollama.js',
      'package/dist/providers/llama-server.js',
      'package/dist/providers/claude-cli.js',
      'package/dist/providers/claude-code.js',
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
    if (hits.length > 0)
      fail(`forbidden in tarball: ${forbid} (${hits.length} hits, e.g. ${hits[0]})`);
    ok(`no ${forbid}`);
  }
}

async function scratchInstall(tarballs: string[]): Promise<void> {
  step('scratch install');
  await $`npm init -y`.cwd(SCRATCH).quiet();
  // npm needs the tarballs by path; pass all packages at once so peer
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

// === @inbrowser/resumable (ROOT-ONLY barrel) ===
// Stores, the SSE HTTP binding, and the reconnecting client all hang off
// the single root export now (no /memory, /rtdb, /http, /client subpaths).
import {
  createMemoryJobStore,
  sseFromJob,
  createResumableClient as createResumableJobClient,
  installBrowserLifecycle as installResumableLifecycle,
} from '@inbrowser/resumable';
const store = createMemoryJobStore();
assert.equal(typeof store.create, 'function');
assert.equal(typeof store.append, 'function');
console.log('  ✓ resumable: createMemoryJobStore wired (root barrel)');
assert.equal(typeof sseFromJob, 'function', 'resumable: sseFromJob');
assert.equal(typeof createResumableJobClient, 'function', 'resumable: createResumableClient');
assert.equal(typeof installResumableLifecycle, 'function', 'resumable: installBrowserLifecycle');
console.log('  ✓ resumable: http binding + client lifted to root barrel');

// === @inbrowser/relay ===
// Providers moved to @inbrowser/model (stage 4) — relay no longer exports
// them; it exposes the transport + client + SSE utilities.
import {
  createRelay,
  createResumableClient,
  installBrowserLifecycle,
  encodeSseEvent,
  readSseDataLines,
  SSE_DONE_LINE,
  createAstroRoutes,
  createExpressHandlers,
} from '@inbrowser/relay';
assert.equal(typeof createRelay, 'function');
console.log('  ✓ relay: createRelay exported (providers moved to @inbrowser/model)');

// Client + SSE utilities + framework adapters all on the ROOT barrel now
// (no /client, /sse, /adapters/* subpaths).
assert.equal(typeof createResumableClient, 'function');
assert.equal(typeof installBrowserLifecycle, 'function');
assert.equal(typeof encodeSseEvent, 'function');
assert.equal(typeof readSseDataLines, 'function');
assert.equal(typeof SSE_DONE_LINE, 'string');
console.log('  ✓ relay: client + SSE utilities on root barrel');

assert.equal(typeof createAstroRoutes, 'function', 'relay: createAstroRoutes');
assert.equal(typeof createExpressHandlers, 'function', 'relay: createExpressHandlers');
console.log('  ✓ relay: astro + express adapters on root barrel');

// === @inbrowser/agent ===
import {
  createAgentSession,
  createAgentTools,
  createReactLoopStrategy,
  createToolRegistry,
} from '@inbrowser/agent';
assert.equal(typeof createAgentSession, 'function');
assert.equal(typeof createAgentTools, 'function');
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

import * as sandboxBridge from '@inbrowser/agent/sandbox';
assert.equal(typeof sandboxBridge.createSandboxAgentTools, 'function');
console.log('  ✓ agent/sandbox: sandbox bridge exported');

// === @inbrowser/workspace + @inbrowser/sandbox ===
import { createBrowserWorkspace } from '@inbrowser/workspace';
import {
  createRuntimeAdapter,
  createSandbox,
  createWorkspaceSandbox,
  standardSandboxTools,
} from '@inbrowser/sandbox';
assert.equal(typeof createBrowserWorkspace, 'function');
assert.equal(typeof createWorkspaceSandbox, 'function');
assert.equal(typeof standardSandboxTools, 'function');
assert.equal(typeof createSandbox, 'function');
assert.equal(typeof createRuntimeAdapter, 'function');

const workspace = await createBrowserWorkspace({ id: 'smoke-pack', storage: 'memory' });
const sandbox = await createWorkspaceSandbox({ workspace });
assert.ok(sandbox.tools.get('write'), 'sandbox should install standard write tool');
const write = await sandbox.tools.run('write', { path: 'notes.txt', content: 'one' });
assert.equal(write.ok, true, 'sandbox write should succeed');
const checkpoint = await sandbox.checkpoints.create('before edit');
await sandbox.tools.run('write', { path: 'notes.txt', content: 'two' });
await sandbox.checkpoints.restore(checkpoint.id);
const read = await sandbox.tools.run('read', { path: 'notes.txt' });
assert.equal(read.ok, true, 'sandbox read should succeed');
assert.equal(read.data.content, 'one');
const sandboxTools = sandboxBridge.createSandboxAgentTools(sandbox, { names: ['read'] });
assert.equal(sandboxTools.list().length, 1);
assert.equal(sandboxTools.list()[0].name, 'read');
const dispatchRead = await sandboxTools.execute(
  { id: 'read-notes', name: 'read', args: { path: 'notes.txt' } },
  { signal: new AbortController().signal },
);
assert.equal(dispatchRead.ok, true);
console.log('  ✓ workspace+sandbox: memory workspace, tools, checkpoints, and agent bridge work');

// === @inbrowser/model ===
// Import shape only — createEngine() needs @huggingface/transformers
// and a real model to do anything. Smoke just verifies the surface.
// Presets are also reachable from root for ergonomics.
import {
  createEngine,
  definePreset,
  splitThinking,
  parseToolCalls,
  gemma4_E2B,
  gemma4_E4B,
  smollm2_360m,
  qwen2_5_coder_1_5b,
  qwen3_1_7b,
  deepseek_r1_qwen_1_5b,
} from '@inbrowser/model';
assert.equal(typeof createEngine, 'function');
assert.equal(typeof definePreset, 'function');
assert.equal(typeof splitThinking, 'function');
assert.equal(typeof parseToolCalls, 'function');
for (const [name, p] of [
  ['gemma4_E2B', gemma4_E2B],
  ['gemma4_E4B', gemma4_E4B],
  ['smollm2_360m', smollm2_360m],
  ['qwen2_5_coder_1_5b', qwen2_5_coder_1_5b],
  ['qwen3_1_7b', qwen3_1_7b],
  ['deepseek_r1_qwen_1_5b', deepseek_r1_qwen_1_5b],
]) {
  assert.equal(typeof p.model.modelId, 'string', \`preset \${name} should have model.modelId\`);
  assert.equal(typeof p.dtype, 'string', \`preset \${name} should have dtype\`);
}
console.log('  ✓ model: createEngine + utilities + six presets exported from root');

// Worker host/connect helpers are exported from the root barrel.
import * as modelRoot from '@inbrowser/model';
assert.equal(typeof modelRoot.hostEngineInWorker, 'function');
assert.equal(typeof modelRoot.connectWorkerEngine, 'function');
console.log('  ✓ model: worker host/connect helpers exported from root');

// === @inbrowser/model cloud provider factories + withRetry (stage 4) ===
import {
  geminiModelClient,
  ollamaModelClient,
  openaiCompatModelClient,
  llamaServerModelClient,
  anthropicModelClient,
  claudeCliModelClient,
  createFirebaseAiLogicModelClient,
  withRetry,
} from '@inbrowser/model';
for (const [name, fn] of [
  ['geminiModelClient', geminiModelClient],
  ['ollamaModelClient', ollamaModelClient],
  ['openaiCompatModelClient', openaiCompatModelClient],
  ['llamaServerModelClient', llamaServerModelClient],
  ['anthropicModelClient', anthropicModelClient],
  ['claudeCliModelClient', claudeCliModelClient],
  ['createFirebaseAiLogicModelClient', createFirebaseAiLogicModelClient],
  ['withRetry', withRetry],
]) {
  assert.equal(typeof fn, 'function', \`model root: \${name} should be a function\`);
}
// Constructing a factory yields a ModelClient (id + supportsTools + chat).
const geminiClient = geminiModelClient({ apiKey: 'sk-test', model: 'gemini-3-flash-preview' });
assert.equal(geminiClient.id, 'gemini:gemini-3-flash-preview');
assert.equal(typeof geminiClient.chat, 'function');
const llamaClient = llamaServerModelClient({ model: 'qwen2.5-coder' });
assert.equal(llamaClient.id, 'llama:qwen2.5-coder');
assert.equal(typeof llamaClient.chat, 'function');

// Firebase itself is deliberately absent from this scratch install. A
// caller-constructed structural model is enough to use the adapter.
const firebaseClient = createFirebaseAiLogicModelClient({
  model: 'models/gemini-3.5-flash',
  async generateContentStream(request, options) {
    assert.equal(request.contents[0].parts[0].text, 'smoke');
    assert.equal(options.signal.aborted, false);
    return {
      stream: (async function* () {
        yield {
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        };
      })(),
      response: Promise.resolve({}),
    };
  },
});
assert.equal(firebaseClient.id, 'firebase-ai-logic:models/gemini-3.5-flash');
assert.equal(firebaseClient.supportsTools, true);
const firebaseEvents = [];
for await (const event of firebaseClient.chat(
  {
    messages: [{ role: 'user', text: 'smoke' }],
    tools: [],
    toolUseEnabled: false,
  },
  new AbortController().signal,
)) {
  firebaseEvents.push(event);
}
assert.deepEqual(firebaseEvents, [
  { kind: 'text', text: 'ok' },
  { kind: 'usage', usage: { promptTokens: 1, outputTokens: 1 } },
]);
console.log('  ✓ model: provider factories, Firebase adapter, and withRetry exported from root');

// The engine→ModelClient adapter resolves from the root and is a function
// (the on-device engine is now a ModelClient).
import { createEngineModelClient } from '@inbrowser/model';
assert.equal(typeof createEngineModelClient, 'function', 'model root: createEngineModelClient');
console.log('  ✓ model: createEngineModelClient resolves from root');
`,
  );
  await $`node test.mjs`.cwd(SCRATCH);
  ok('scratch dir import test passed');
}

async function browserBundle(): Promise<void> {
  step('browser-target bundle of @inbrowser/relay (root barrel)');
  // The scratch dir already has @inbrowser/relay installed. Resolve
  // through node_modules so the test uses the *packed* output, not the
  // local source. Bundling the ROOT barrel for the browser proves the
  // whole flattened entrypoint is browser-import-safe: the Express
  // adapter's `node:stream` is lazy-`import()`ed inside its handler and
  // its `node:http` imports are type-only, so a browser-target bundle of
  // the root must succeed with NO static `node:` reference.
  const entry = join(SCRATCH, 'node_modules/@inbrowser/relay/dist/index.js');
  if (!existsSync(entry)) fail(`browser entry missing: ${entry}`);
  const out = join(SCRATCH, 'browser-bundle');
  await $`bun build --target=browser --outdir=${out} ${entry}`.cwd(SCRATCH);
  ok(`bundled @inbrowser/relay root barrel for the browser (output: ${out})`);
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
