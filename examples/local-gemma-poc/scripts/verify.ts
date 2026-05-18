/**
 * Headless verification of the local-gemma-poc example.
 *
 * Launches headless Chromium (Playwright), navigates to the running
 * dev server, clicks "Generate", and observes:
 *
 *   - WebGPU availability under headless
 *   - Console + page errors (anything thrown during module load)
 *   - LoadProgress phases the page reaches (fetch / init / warmup / ready)
 *   - First-token latency, decode rate, final usage line
 *
 * Designed to be useful even when the run is interrupted partway
 * (e.g., model fetch can't complete on a constrained network) — the
 * report prints whatever signals we observed.
 *
 * Usage:
 *
 *   # dev server must be running (bun run --cwd examples/local-gemma-poc dev)
 *   bun run examples/local-gemma-poc/scripts/verify.ts
 *   bun run examples/local-gemma-poc/scripts/verify.ts --url http://localhost:5175 --timeout 120000
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type ConsoleMessage } from 'playwright';

interface Options {
  url: string;
  timeoutMs: number;
  prompt: string;
  userDataDir: string;
  backend: 'webgpu' | 'wasm' | 'auto';
  preset: string;
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : fallback;
  };
  const backendRaw = get('--backend', 'wasm');
  if (backendRaw !== 'webgpu' && backendRaw !== 'wasm' && backendRaw !== 'auto') {
    throw new Error(`--backend must be webgpu|wasm|auto, got: ${backendRaw}`);
  }
  return {
    url: get('--url', 'http://localhost:5175'),
    timeoutMs: Number.parseInt(get('--timeout', '120000'), 10),
    prompt: get('--prompt', 'Say hello in one short sentence.'),
    // Persistent profile on the real disk — avoids the WSL2 tmpfs
    // user-data-dir trap that caps StorageManager quota.
    userDataDir: get('--user-data-dir', join(homedir(), '.cache', 'inbrowser-playwright')),
    // Default 'wasm' for headless verify: headless WebGPU on Linux
    // typically lacks shader-f16 and caps maxBufferSize at 1 GiB,
    // both of which Gemma 4 E2B needs. Use --backend webgpu only
    // when running against a real GPU.
    backend: backendRaw,
    // Default 'smollm2_360m' — small enough that headless WASM
    // completes load + decode in well under a minute. Use
    // --preset gemma4_e2b on real hardware.
    preset: get('--preset', 'smollm2_360m'),
  };
}

interface StorageEstimate {
  quotaMb: number | null;
  usageMb: number | null;
  raw: { quota?: number; usage?: number } | null;
}

async function estimateStorage(page: import('playwright').Page): Promise<StorageEstimate> {
  return page.evaluate(async () => {
    if (!navigator.storage?.estimate) return { quotaMb: null, usageMb: null, raw: null };
    const e = await navigator.storage.estimate();
    return {
      quotaMb: typeof e.quota === 'number' ? Math.round(e.quota / 1024 / 1024) : null,
      usageMb: typeof e.usage === 'number' ? Math.round(e.usage / 1024 / 1024) : null,
      raw: { ...(typeof e.quota === 'number' ? { quota: e.quota } : {}), ...(typeof e.usage === 'number' ? { usage: e.usage } : {}) },
    };
  });
}

interface Snapshot {
  status: string;
  hasError: boolean;
  progressValue: number | null;
  progressHidden: boolean;
  output: string;
  usage: string;
  buttonText: string;
}

async function readSnapshot(page: import('playwright').Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const statusEl = document.getElementById('status');
    const progressEl = document.getElementById('progress') as HTMLProgressElement | null;
    return {
      status: statusEl?.textContent ?? '',
      hasError: statusEl?.classList.contains('error') ?? false,
      progressValue: progressEl && !progressEl.hasAttribute('value') ? null : (progressEl?.value ?? null),
      progressHidden: progressEl?.hidden ?? true,
      output: document.getElementById('output')?.textContent ?? '',
      usage: document.getElementById('usage')?.textContent ?? '',
      buttonText: document.getElementById('generate')?.textContent ?? '',
    };
  });
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const startedAt = Date.now();
  const stamp = (): string => `[+${((Date.now() - startedAt) / 1000).toFixed(2)}s]`;
  const log = (kind: string, msg: string): void => {
    console.log(`${stamp().padEnd(10)} ${kind.padEnd(10)} ${msg}`);
  };

  log('start', `url=${opts.url} timeout=${opts.timeoutMs}ms`);
  log('start', `user-data-dir=${opts.userDataDir}`);
  log('start', `backend=${opts.backend} preset=${opts.preset}`);

  const targetUrl = new URL(opts.url);
  targetUrl.searchParams.set('backend', opts.backend);
  targetUrl.searchParams.set('preset', opts.preset);

  // Persistent context — same Chromium binary, but a user-data-dir
  // on the real disk instead of Playwright's default ephemeral
  // /tmp path. The Cache API's per-origin quota scales off the
  // filesystem holding the user-data-dir, so this is the lever that
  // unblocks multi-GB model weights.
  const ctx = await chromium.launchPersistentContext(opts.userDataDir, {
    headless: true,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,WebGPU,UseSkiaRenderer',
      '--use-vulkan=swiftshader',
      '--use-angle=vulkan',
    ],
  });

  const page = ctx.pages()[0] ?? (await ctx.newPage());

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (msg: ConsoleMessage) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') {
      consoleErrors.push(text);
      log('console', `[error] ${text}`);
    } else if (type === 'warning') {
      log('console', `[warn]  ${text}`);
    }
    // Drop info/debug noise from transformers.js init — too chatty.
  });

  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
    log('pageerror', err.message);
  });

  // ── 1. Page load ──────────────────────────────────────────────
  try {
    await page.goto(targetUrl.toString(), { waitUntil: 'load', timeout: 10_000 });
  } catch (e) {
    log('fatal', `goto failed: ${e instanceof Error ? e.message : String(e)}`);
    await ctx.close();
    process.exit(2);
  }
  log('nav', `loaded, title=${await page.title()}`);

  // Module load: surface any ESM resolution errors before clicking.
  await page.waitForSelector('#generate:not([disabled])', { timeout: 10_000 }).catch(() => {
    // Button might not flip enabled if WebGPU error path runs first.
  });

  // ── 2. Probe runtime state ────────────────────────────────────
  const probe = await page.evaluate(() => ({
    webgpu: typeof (navigator as Navigator & { gpu?: unknown }).gpu !== 'undefined',
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  }));
  log('probe', `webgpu=${probe.webgpu} cores=${probe.hardwareConcurrency}`);
  log(
    'probe',
    `crossOriginIsolated=${probe.crossOriginIsolated} sharedArrayBuffer=${probe.sharedArrayBuffer}`,
  );
  log('probe', `ua=${probe.userAgent}`);

  const storagePre = await estimateStorage(page);
  log(
    'storage',
    `pre-fetch quota=${storagePre.quotaMb ?? '?'}MB usage=${storagePre.usageMb ?? '?'}MB`,
  );

  const initial = await readSnapshot(page);
  log('ui', `initial status="${initial.status}" button="${initial.buttonText}"`);

  // ── 3. Click generate ─────────────────────────────────────────
  await page.fill('#prompt', opts.prompt);
  log('action', `clicking #generate (prompt: ${JSON.stringify(opts.prompt)})`);
  await page.click('#generate');

  // ── 4. Poll the UI ────────────────────────────────────────────
  const deadline = Date.now() + opts.timeoutMs;
  let lastStatus = '';
  let lastProgressBucket = -1;
  let phasesSeen = new Set<string>();
  let firstTokenAt: number | null = null;
  let firstTokenOutputLen = 0;
  let finalUsage = '';
  let aborted = false;

  while (Date.now() < deadline) {
    const snap = await readSnapshot(page);

    if (snap.status !== lastStatus) {
      lastStatus = snap.status;
      const phaseMatch = snap.status.match(/^(fetching|initializing|warmup|decoding|ready|idle)/i);
      if (phaseMatch?.[1]) phasesSeen.add(phaseMatch[1].toLowerCase());
      log('status', `${snap.hasError ? '[ERROR] ' : ''}${snap.status}`);
    }

    // Bucket progress to 5% steps so we don't spam logs.
    if (typeof snap.progressValue === 'number' && !snap.progressHidden) {
      const bucket = Math.floor(snap.progressValue / 5);
      if (bucket !== lastProgressBucket) {
        lastProgressBucket = bucket;
        log('fetch', `${snap.progressValue.toFixed(0)}%`);
      }
    }

    if (snap.output.length > 0 && firstTokenAt === null) {
      firstTokenAt = Date.now() - startedAt;
      firstTokenOutputLen = snap.output.length;
      log('decode', `first token at +${(firstTokenAt / 1000).toFixed(2)}s (${snap.output.length} chars buffered)`);
    }

    if (snap.usage && snap.usage !== finalUsage) {
      finalUsage = snap.usage;
      log('done', snap.usage);
      break;
    }

    if (snap.hasError) {
      log('error-state', `terminal error reached: ${snap.status}`);
      break;
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  if (Date.now() >= deadline && !finalUsage && !lastStatus.match(/error/i)) {
    aborted = true;
    log('timeout', `exceeded ${opts.timeoutMs}ms — no final usage emitted`);
  }

  // ── 5. Final snapshot + report ────────────────────────────────
  const final = await readSnapshot(page);
  const storagePost = await estimateStorage(page);
  const totalMs = Date.now() - startedAt;

  console.log('\n────────────── REPORT ──────────────');
  console.log(`url:              ${opts.url}`);
  console.log(`preset:           ${opts.preset}`);
  console.log(`backend:          ${opts.backend}`);
  console.log(`user-data-dir:    ${opts.userDataDir}`);
  console.log(`total wall:       ${(totalMs / 1000).toFixed(2)}s`);
  console.log(`webgpu detected:  ${probe.webgpu}`);
  console.log(
    `cross-origin iso: ${probe.crossOriginIsolated} (SAB=${probe.sharedArrayBuffer})`,
  );
  console.log(
    `storage quota:    ${storagePre.quotaMb ?? '?'}MB (pre) → ${storagePost.quotaMb ?? '?'}MB (post)`,
  );
  console.log(
    `storage usage:    ${storagePre.usageMb ?? '?'}MB (pre) → ${storagePost.usageMb ?? '?'}MB (post)`,
  );
  console.log(`page errors:      ${pageErrors.length}`);
  console.log(`console errors:   ${consoleErrors.length}`);
  console.log(`load phases seen: ${[...phasesSeen].join(', ') || '(none)'}`);
  console.log(`first token:      ${firstTokenAt ? `+${(firstTokenAt / 1000).toFixed(2)}s` : 'never'}`);
  console.log(`final status:     ${final.hasError ? '[ERROR] ' : ''}${final.status}`);
  console.log(`output chars:     ${final.output.length}`);
  console.log(`usage line:       ${final.usage || '(none)'}`);
  console.log(`outcome:          ${
    final.hasError ? 'ERROR' :
    finalUsage ? 'SUCCESS' :
    aborted ? 'TIMEOUT' :
    'UNKNOWN'
  }`);

  if (pageErrors.length > 0) {
    console.log('\npage errors:');
    pageErrors.forEach((e) => console.log(`  - ${e}`));
  }
  if (consoleErrors.length > 0) {
    console.log('\nconsole errors:');
    consoleErrors.forEach((e) => console.log(`  - ${e}`));
  }
  if (final.output) {
    console.log('\noutput preview (first 240 chars):');
    console.log(`  ${final.output.slice(0, 240)}${final.output.length > 240 ? '…' : ''}`);
  }

  await ctx.close();

  // Exit code reflects outcome so CI / shell scripts can fail
  // cleanly. A fetch timeout on a constrained network is exit 3,
  // a hard error is exit 1, success is 0.
  if (final.hasError || pageErrors.length > 0) process.exit(1);
  if (finalUsage) process.exit(0);
  process.exit(3);
}

main().catch((e) => {
  console.error('verify script crashed:', e);
  process.exit(2);
});
