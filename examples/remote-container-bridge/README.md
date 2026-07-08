# Remote Container Bridge Example

This example is the smallest real remote-container demo: open the UI, click
**Run container**, and watch stdout stream back from a container while the
process is still running.

It hosts the `@inbrowser/sandbox/remote` protocol through
`startRemoteContainerBridge`, auto-selects the Bun host while the demo runs under
Bun, runs Apple `container` when available, and renders through the shared
React/Vite example shell.

```bash
bun run --cwd examples/remote-container-bridge start
```

Open <http://127.0.0.1:5184>, then press **Run container**. The UI starts a bridge
session, runs the sample command through the configured provider, appends
streamed `run.output` artifacts to the terminal, and closes the session when the
command exits. Diagnostics are available in the secondary Details tab.

The bridge host listens on <http://127.0.0.1:8790>; Vite proxies
`/bridge-config`, `/status`, `/bridge`, and authenticated forwarded port URLs to
it.

By default the server uses Apple `container` and starts a real Linux container:

```bash
REMOTE_CONTAINER_IMAGE=ubuntu:latest bun run --cwd examples/remote-container-bridge start
```

Use the in-memory fake provider only for protocol development, automated tests,
or UI smoke checks:

```bash
REMOTE_CONTAINER_PROVIDER=fake bun run --cwd examples/remote-container-bridge start
```

The bridge host starts before the container runtime is ready. The UI and
`/status?token=<bridge-token>` endpoint report whether the provider is idle,
starting, ready, or failed. Session creation lazily starts the provider, and
socket close or process shutdown disposes containers created for the session.

Exposed container ports are returned as authenticated proxy URLs under the demo
UI origin. The provider supplies the container target URL, while the bridge host
keeps the bridge token on the browser-facing URL.

The browser side connects with:

```ts
import {
  createRemoteSandbox,
  createWebSocketBridgeProvider,
} from '@inbrowser/sandbox/remote';

const sandbox = await createRemoteSandbox({
  id: 'local-container-session',
  transport: createWebSocketBridgeProvider({
    url: 'ws://127.0.0.1:8790/bridge',
    token: '<bridge-token-from-/bridge-config>',
  }),
});
```

Default tests use the fake provider, including a React smoke test for the
one-button stream path. To run the real Apple container integration test
locally:

```bash
INBROWSER_TEST_APPLE_CONTAINER=1 REMOTE_CONTAINER_IMAGE=ubuntu:latest bun run --cwd examples/remote-container-bridge test
```
