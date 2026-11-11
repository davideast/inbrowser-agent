# Guide: embedding and hosting `@inbrowser/node`

This guide covers what `@inbrowser/node` provides, what headers and static assets a host application serves, and how to use `BrowserContainer` and `SandboxContainer`. What is supported and where it stops is documented in [limits.md](limits.md).

## What it is

The browser's JavaScript engine executes guest CommonJS and ESM code in dedicated process Workers, while a separate kernel Worker owns a shared in-memory POSIX filesystem. Synchronous syscalls cross the Worker boundary over `SharedArrayBuffer` and `Atomics`. A Service Worker serves process-scoped ES module graphs and routes browser HTTP, streaming SSR, SSE, and WebSocket traffic into guest Node servers.

It is not a hardened untrusted-code sandbox against hostile native/JS exploits: guest processes are trusted within their Worker realm. To isolate the parent embedder origin's DOM, cookies, `localStorage`, and IndexedDB from guest Workers and preview documents, pair `SandboxContainer` with per-origin previews (`BootOptions.preview.origin`); see [threat-model.md](../reference/threat-model.md).

## Hosting requirements

- Serve the host page and runtime Worker scripts with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- The Service Worker requires root scope (`/`). If `sw.js` is hosted under a nested directory, serve it with `Service-Worker-Allowed: /`.
- `BrowserContainer.boot({ assetBaseURL: '/engine/' })` loads the prebuilt Worker scripts (`kernel.js`, `process.js`, `sw.js`, `preview-socket.js`, `context-compiler-worker.js`) and on-demand sidecar WebAssembly binaries (`sqlite.wasm`, `zlib-brotli.wasm`, `zlib-zstd.wasm`, `context-esbuild.wasm` — exported as `@inbrowser/node/assets/*` and served as `application/wasm`) from a same-origin directory. The host validates same-origin placement before any Worker starts.
- Import the runtime from `@inbrowser/node`. When the host application already owns its root Service Worker, import `installRuntimeServiceWorker` and `isRuntimeRequest` from `@inbrowser/node/service-worker` inside that Service Worker and boot with `serviceWorker: 'existing'`. The default `serviceWorker: 'register'` registers `sw.js` automatically.

```ts
import { BrowserContainer } from '@inbrowser/node';

const container = await BrowserContainer.boot({ assetBaseURL: '/engine/' });
await container.mount({ '/hello.cjs': "console.log('hi')" });
const proc = await container.spawn('node', ['/hello.cjs']);
console.log(await proc.exit, proc.stdoutText);
await container.teardown();
```

## `BrowserContainer` API

| Member | What it does |
| --- | --- |
| `BrowserContainer.boot(options?)` | Starts the kernel Worker and Service Worker and returns a `BrowserContainer`. |
| `mount(files)` | Writes absolute file paths into the VFS. Values are `string`, `Uint8Array`, or `{ data, mode? }` (`0` to `0o7777`; e.g. `0o755` for executable scripts). Invalid entries reject atomically before writing. |
| `spawn('node', [entry, ...args], options?)` | Starts a guest Node process; `spawn('sh', ['-c', command], options?)` runs the scoped shell. Options: `cwd`, `env`, `stdin: 'pipe'`, `terminal`. |
| `preview(port, options?)` | Waits for a guest listener on `port` and returns its preview URL. Options: `requestPath: 'preserve'`, `webSocket`, `clientScript` (injected into `200` HTML responses with a `MessagePort` delivered to `onPreviewClient`). |
| `onPreviewClient(port, handler)` | Subscribes to `MessagePort` connections opened by `PreviewOptions.clientScript` across preview navigations and reloads; returns an `unsubscribe()` callback. |
| `previewStreams()` | Reports preview exchanges in progress, peak body bytes in flight per direction, and the last transport failure. |
| `resources()` | Reports live process, owned-descriptor, and listener counts. |
| `fs.readFile` / `fs.writeFile` | Host-side asynchronous reads and writes against the canonical VFS. |
| `fs.readdir`, `fs.stat`, `fs.lstat`, `fs.mkdir`, `fs.rename`, `fs.rm` | Host-side directory and metadata operations (`{ type, mode, size }`). |
| `fs.watch(path, { recursive? })` | Returns a `ReadableStream` of VFS change events. |
| `install({ cwd })` | Experimental. Installs registry packages from a mounted v3 lockfile with SHA-512 verification and creates bin symlinks. |
| `snapshot()`, `restore(snapshot)` | Export and replace the VFS of a stopped container. |
| `saveSnapshot(name)`, `restoreSnapshot(name)` | Persist and restore a snapshot through IndexedDB on the container host origin. |
| `checkpoint(name, { startup })`, `recover(name)` | Experimental. Persist VFS contents and startup configuration; `recover` restores files and returns the configuration. |
| `savePackageCache` / `restorePackageCache` / `removePackageCache` | Experimental. Persist, restore, or evict verified npm download caches in IndexedDB. |
| `teardown()` | Terminates Workers and settles pending operations cleanly. |
| `ContainerProcess` | `pid`, `exit`, `kill()`, `resize()`, `stdout`, `stderr`, `stdoutText`, `stderrText`, `stdoutTruncatedBytes`, `stderrTruncatedBytes`, `stdoutStream`, `stderrStream`, `stdin`. |

### Boot options

| Option | Meaning |
| --- | --- |
| `assetBaseURL` | Same-origin directory serving `@inbrowser/node/assets/*`. |
| `serviceWorker` | `'register'` (default) or `'existing'`. |
| `asyncContext` | `'experimental'` enables `AsyncLocalStorage`, `AsyncResource`, and continuation lowering via `esbuild-wasm`. |
| `httpAgentMode` | `'socket'` (default) or `'fetch'` (enables full HTTP methods, outbound request bodies, `AbortSignal`, and `Agent` scheduling). |
| `httpAllowedHosts`, `httpBlockedHosts`, `httpEgress` | Outbound guest HTTP/HTTPS host and port allowlist/denylist rules (`EACCES` on disallowed targets). |
| `httpOmitHeaders` | Maps exact HTTP(S) origins to header names omitted from outbound Fetch requests. |
| `resources` | Deep-partial override of `DEFAULT_RESOURCE_POLICY` byte caps, counts, and deadlines. See [resource-policy.md](../reference/resource-policy.md). |
| `preview` | Opt-in per-origin preview `{ origin: 'https://{container}-{port}.preview.example.com', embedderPolicy?: 'require-corp' }`. |

## Per-origin preview & preview client channel

By default `preview(port)` returns `<host>/__preview__/<container>/<port>/` for apps using relative URLs. Apps with root-relative URLs (`/assets/app.js`, `fetch('/api')`, router `location.pathname`) opt into per-origin previews:

```ts
const container = await BrowserContainer.boot({
  preview: { origin: 'https://{container}-{port}.preview.example.com' },
});
const url = await container.preview(3000, {
  clientScript: `
    window.__inbrowserPreviewPort?.postMessage({ type: 'ready', href: location.href });
  `,
});
```

On every preview origin, serve the three files from `@inbrowser/node/preview-origin/*` with `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: cross-origin`, and `Cache-Control: no-store`:

| Path | Serve |
| --- | --- |
| `/__inbrowser_preview_sw.js` | `__inbrowser_preview_sw.js` (`text/javascript`) |
| `/__inbrowser__/bridge.html` | `__inbrowser__/bridge.html` (`text/html`) |
| any other path | `__inbrowser__/unavailable.html` with status `503` |

When `clientScript` is provided to `preview(port, { clientScript })`, the Service Worker injects the client bootstrap into `200` HTML responses (decoding `gzip`/`deflate` HTML when compressed while leaving non-HTML assets untouched) and delivers a connected `MessagePort` (`window.__inbrowserPreviewPort`) to `container.onPreviewClient(port, (clientPort) => ...)` on every navigation.

## 3-origin isolation (`SandboxContainer` + `installSandboxHost`)

`SandboxContainer.boot(sandboxUrl, options)` runs `BrowserContainer`, its Kernel and Process Workers, Service Worker, and IndexedDB inside a dedicated cross-origin host frame (`installSandboxHost` from `@inbrowser/node/sandbox-host`). Combined with per-origin previews, the parent embedder origin, the sandbox runtime origin, and each preview origin are mutually isolated across three origins; see [threat-model.md §7](../reference/threat-model.md#7-cross-origin-sandbox-host).

## Runtime modes

- **Default mode**: Runs guest CJS and ESM directly on the browser JS engine with zero compilation pass for CJS and minimal import-specifier rewriting for ESM. `AsyncLocalStorage` activation is disabled so concurrent requests never silently mix state.
- **`asyncContext: 'experimental'`**: Enables process-owned async context frames, `AsyncLocalStorage`, `AsyncResource`, and browser-side continuation lowering through `context-compiler-worker.js` (`esbuild-wasm`) so per-request stores propagate across `async`/`await`, timers, streams, and HTTP servers.

## Further reading

- [Supported surface and deliberate limits](limits.md)
- [Architecture reference](../reference/architecture.md)
- [Resource policy](../reference/resource-policy.md)
- [Threat model and security posture](../reference/threat-model.md)
