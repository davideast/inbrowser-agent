# `@inbrowser/driver`

Fast 1-RTT browser UI observation, transactional action execution, and visual capture driver for live `<iframe>` previews, `MessagePort` channels, `@inbrowser/node` container previews, and optional real-CDP tabs.

- **Zero Core Runtime Dependencies:** Core, preload, and agent tool bundles are browser-safe with zero runtime npm dependencies.
- **1-RTT Semantic Observation & Transactional Actions:** Compact ARIA, landmark, `data-driver`, and open Shadow DOM snapshots with `<video>`, `<audio>`, `<canvas>`, and `<svg>` metadata, drained console/page/network/compile diagnostics, self-healing semantic fingerprints, user-takeover abort guards, and localized revision diffs.
- **Silent & GPU Visual Capture:** In-frame silent WebP/PNG screenshots and WebM video recordings on cross-origin previews without screen-share prompts, plus optional `DisplayMediaProvider` GPU capture (`RestrictionTarget` / `CropTarget`).

## Package Entrypoints

| Entrypoint | Environment | Exports |
| --- | --- | --- |
| `@inbrowser/driver` | Browser / Neutral | `PageDriver`, `DriverError`, `connectContainerPreview`, `connectSandboxPreview`, `connectIframe`, `connectPort`, `buildContainerPreviewClientScript`, protocol type guards |
| `@inbrowser/driver/preload` | Browser / Neutral | `DRIVER_PRELOAD_SOURCE`, `DRIVER_PRELOAD_BYTE_LENGTH` (`<= 44 KiB` minified, `<= 16 KiB` gzipped) |
| `@inbrowser/driver/tools` | Browser / Neutral | `createDriverTools` (`ui_observe`, `ui_act`, `ui_capture`, opt-in `ui_eval`), JSON Schemas, compact YAML formatters |
| `@inbrowser/driver/puppeteer` | Node / CDP (`puppeteer-core`) | `connectPuppeteerDriver`, `PuppeteerDriverOptions`, `ConnectionTransport` |

## Quick Start

### 1. Connect an `@inbrowser/node` `SandboxContainer` or `BrowserContainer` Preview

`connectContainerPreview` (alias `connectSandboxPreview`) injects `DRIVER_PRELOAD_SOURCE` via `PreviewOptions.clientScript`, subscribes to `container.onPreviewClient(port, ...)`, navigates an optional `<iframe>`, and automatically rebinds fresh `MessagePort`s across cross-origin full-page navigations:

```ts
import { connectContainerPreview } from '@inbrowser/driver';
import { createDriverTools } from '@inbrowser/driver/tools';

const iframe = document.createElement('iframe');
document.body.appendChild(iframe);

const { previewUrl, driver } = await connectContainerPreview(sandbox, 3000, {
  iframe,
});

// Zero-glue tool handlers compatible with @inbrowser/agent and @inbrowser/sandbox
const tools = createDriverTools(driver);

// Or call the PageDriver API directly:
const snapshot = await driver.observe();
const actResult = await driver.act({
  rev: snapshot.rev,
  steps: [
    { kind: 'fill', target: { role: 'textbox', name: 'Item Title' }, value: 'Draft v1' },
    { kind: 'click', target: { role: 'button', name: 'Save' } },
  ],
});
const screenshot = await driver.capture({ mode: 'screenshot', format: 'webp' });

driver.dispose();
```

### 2. Connect a Preloaded `<iframe>` or `MessagePort`

Inject `DRIVER_PRELOAD_SOURCE` from `@inbrowser/driver/preload` into the guest document `<head>` before guest scripts run, then connect from the host frame:

```ts
import { connectIframe, connectPort } from '@inbrowser/driver';
import { DRIVER_PRELOAD_SOURCE } from '@inbrowser/driver/preload';

// Direct iframe handshake (supports cross-origin frames):
const iframeDriver = await connectIframe(iframeElement, { allowEval: false });

// Or over an explicit MessagePort pair:
const portDriver = await connectPort(hostPort);
```

### 3. Agent Tool Surface (`@inbrowser/driver/tools`)

`createDriverTools(driver, options)` returns structured, non-throwing tool definitions with token-budgeted YAML summaries:

- `ui_observe` — Observe semantic refs, media/canvas state, and drained diagnostics (`scope`, `includeAllText`).
- `ui_act` — Execute a transactional batch of steps (`click`, `fill`, `setValue`, `select`, `press`, `drag`, `navigate`, `waitFor`) against `rev` in 1 RTT.
- `ui_capture` — Capture `screenshot` (`webp` / `png`, viewport or `target`) or `start_recording` / `stop_recording` (`video/webm`).
- `ui_eval` — Opt-in (`{ allowEval: true }` on both driver and `createDriverTools`) JavaScript expression evaluation with drained diagnostics.

### 4. Real-CDP Backend (`@inbrowser/driver/puppeteer`)

When `puppeteer-core` is installed, `connectPuppeteerDriver` provides the identical `PageDriver` contract backed by Chrome DevTools Protocol (`trustedInput: true`, native CDP screenshots/screencast):

```ts
import { connectPuppeteerDriver } from '@inbrowser/driver/puppeteer';

const driver = await connectPuppeteerDriver({
  browserWSEndpoint: 'ws://127.0.0.1:9222/devtools/browser/...',
  targetUrl: 'http://localhost:3000/',
});

const snap = await driver.observe();
driver.dispose();
```

## Development & Verification

From the monorepo root:

```bash
bun run build:driver
bun run --cwd packages/driver typecheck
bun run --cwd packages/driver test
bun run test:e2e:driver
```

## License

MIT licensed. Built `dist/` artifacts include `LICENSE` and `THIRD_PARTY_NOTICES.txt`.
