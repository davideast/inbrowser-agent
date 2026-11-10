# `@inbrowser/node`

Browser-isolated Node.js `22.18` container runtime for the `@inbrowser` stack.

Guest CommonJS and ES module programs run inside dedicated browser Web Workers while a separate kernel Worker owns a shared in-memory POSIX filesystem (`memfs`) synchronized across Workers with `SharedArrayBuffer` and `Atomics`. A Service Worker serves process-scoped ES module graphs and routes browser HTTP, streaming SSR, SSE, and WebSocket requests into guest Node servers.

`@inbrowser/node` is not a hardened untrusted-code sandbox against hostile native or JS engine exploits: guest code executes as trusted code inside its dedicated Worker realm. To isolate the parent embedder origin's DOM, cookies, `localStorage`, and IndexedDB from guest Workers and preview documents, pair `SandboxContainer` with per-origin previews (`BootOptions.preview.origin`); see [threat-model.md](docs/reference/threat-model.md).

## Install

```bash
bun add @inbrowser/node
```

`@inbrowser/node` ships self-contained browser bundles and on-demand WebAssembly sidecars in `dist/` with **zero runtime npm dependencies**.

## Quick start

Serve your host page and `@inbrowser/node/assets/*` from a cross-origin-isolated origin (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, plus `Service-Worker-Allowed: /` if `sw.js` is served from a subdirectory):

```ts
import { BrowserContainer } from '@inbrowser/node';

const container = await BrowserContainer.boot({
  assetBaseURL: '/engine/',
});

await container.mount({
  '/server.mjs': `
    import http from 'node:http';
    import { DatabaseSync } from 'node:sqlite';

    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE greetings (msg TEXT); INSERT INTO greetings VALUES ("Hello from BrowserContainer");');
    const row = db.prepare('SELECT msg FROM greetings').get();

    http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(row));
    }).listen(3000);
  `,
});

const server = await container.spawn('node', ['/server.mjs']);
const previewUrl = await container.preview(3000);
const res = await fetch(previewUrl);
console.log(await res.json()); // { msg: 'Hello from BrowserContainer' }

server.kill();
await server.exit;
await container.teardown();
```

When your host app already owns the root Service Worker, install the runtime handler inside your Service Worker via `@inbrowser/node/service-worker` and boot with `serviceWorker: 'existing'`:

```ts
import { installRuntimeServiceWorker } from '@inbrowser/node/service-worker';

installRuntimeServiceWorker();
```

## Entrypoints

| Subpath | Purpose |
| --- | --- |
| `@inbrowser/node` | `BrowserContainer`, `SandboxContainer`, `installSandboxHost`, `DEFAULT_RESOURCE_POLICY`, typed error classes (`RuntimeError`, `UnsupportedError`, `LimitError`, `ChannelError`, `LifecycleError`), and TypeScript types. |
| `@inbrowser/node/service-worker` | `installRuntimeServiceWorker()` and `isRuntimeRequest()` for composing with an existing root Service Worker (`serviceWorker: 'existing'`). |
| `@inbrowser/node/sandbox-host` | Cross-origin sandbox iframe host bootstrap (`installSandboxHost()`, `SandboxContainer`). |
| `@inbrowser/node/assets/*` | Prebuilt Worker scripts (`kernel.js`, `process.js`, `sw.js`, `preview-socket.js`, `context-compiler-worker.js`) and lazy WebAssembly sidecars (`sqlite.wasm`, `zlib-brotli.wasm`, `zlib-zstd.wasm`, `context-esbuild.wasm`). |
| `@inbrowser/node/preview-origin/*` | Static assets (`__inbrowser_preview_sw.js`, `__inbrowser__/bridge.html`, `__inbrowser__/unavailable.html`) for dedicated per-origin preview domains. |

## Capabilities

- **Kernel & POSIX VFS**: Shared volume across processes, synchronous syscalls over `SharedArrayBuffer` + `Atomics`, owner permission bits, `fs` / `fs/promises` (`glob`, `cp`, `watch`, `watchFile`, `openAsBlob`, streams), snapshots, IndexedDB persistence, and `container.fs` host operations.
- **CJS & ESM loader**: Node `22.18` `exports`/`imports` resolution, Service-Worker-backed ES module graphs with live bindings and top-level `await`, and CJS named-export detection.
- **Processes, shell & threads**: Independently terminable process Workers (`spawn`, `fork` with structured IPC, `exec`), scoped `sh -c`, and file-backed `worker_threads`.
- **HTTP, streaming SSR, SSE & WebSockets**: `node:http` / `node:https` servers, bidirectional streaming request/response windows, WebSocket upgrades, per-origin previews (`BootOptions.preview.origin`), `PreviewOptions.clientScript` + `onPreviewClient` `MessagePort` channels, and Fetch-backed outbound HTTP (`httpAgentMode: 'fetch'`) with request bodies and host/port egress policies.
- **Builtins & lazy WASM codecs**: `node:stream` and full Web Streams adapters (`Readable` / `Writable` / `Duplex` `.toWeb` and `.fromWeb`), `node:zlib` (`gzip`, `deflate`, `brotli`, `zstd`), `node:sqlite` (`DatabaseSync`, `StatementSync`, UDFs, sessions, backups), `node:crypto` (WebCrypto + ciphers/signing/KDFs + constant-time `timingSafeEqual`), `node:v8` serializer, `node:test` runner, and opt-in `asyncContext: 'experimental'` (`AsyncLocalStorage`).
- **3-origin isolation**: `SandboxContainer` + `installSandboxHost` isolates the parent embedder origin, the Worker/IndexedDB sandbox host origin, and per-port preview origins.

## Documentation

- [Embedding & hosting guide](docs/guide/README.md)
- [Supported surface & deliberate limits](docs/guide/limits.md)
- [Architecture reference](docs/reference/architecture.md)
- [Resource policy](docs/reference/resource-policy.md)
- [Threat model & security posture](docs/reference/threat-model.md)

## Development

From the monorepo root:

```bash
bun run --cwd packages/node typecheck
bun run --cwd packages/node build
bun run --cwd packages/node test
bun run --cwd packages/node test:e2e
```

MIT licensed. Built `dist/` artifacts include `LICENSE` and `THIRD_PARTY_NOTICES.txt` covering bundled runtime shims and vendored Node.js pure-JS modules.
