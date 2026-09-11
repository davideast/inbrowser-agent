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

## Firebase RTDB transport

WebSocket remains the default. `REMOTE_CONTAINER_TRANSPORT=firebase-rtdb bun start` starts the configured Firebase executor and UI together; `REMOTE_CONTAINER_PROVIDER=fake` selects the fake provider. Set `VITE_REMOTE_CONTAINER_TRANSPORT=firebase-rtdb` for the Firebase UI, or run `bun run firebase:ui`. Run the executor separately with `bun run firebase:host`; this does not start the WebSocket server. `REMOTE_CONTAINER_PROVIDER=fake` selects the in-memory executor; otherwise it uses Apple containers with the `Dockerfile.firebase` image.

Provision the `database` subtree from `firebase.fixture.json` and the packaged reference Rules into your dedicated Firebase project. Replace example UIDs with the actual owner/developer/reviewer/executor UIDs from Firebase Auth. Enable your chosen Auth sign-in method; the sample login uses email/password. **Do not deploy the local fixture passwords.** Owners can edit membership after provisioning. No hosted login, pairing or provisioning service is included.

The host reads `FIREBASE_CONFIG` (the Firebase web configuration JSON), `FIREBASE_EXECUTOR_EMAIL`, and `FIREBASE_EXECUTOR_PASSWORD` from its environment. Optional settings: `FIREBASE_EXECUTOR_ID` (default `demo`), `FIREBASE_STATE_DIRECTORY` (private host directory), `REMOTE_CONTAINER_IMAGE` (default `inbrowser-firebase:latest`). Keep credentials and state outside the container. Enter your Firebase web config and a developer/reviewer login in the browser form; passwords are not persisted by the example UI.

1. Attach as developer; write `hello.txt` and start the streaming command.
2. In a second tab, attach to the same session as reviewer. Read the file and observe output. Run/write actions demonstrate enforced permission denials.
3. Detach and reconnect using the same session ID. The container survives during the reconnect grace period.
4. Stop the host to dispose its containers.

Build the Apple image first:

```sh
container build -t inbrowser-firebase:latest -f Dockerfile.firebase .
```

For local integration development, use the packed local Pyric workflow and multi-identity demonstration tests in the [sandbox Firebase guide](../../packages/sandbox/docs/firebase-rtdb.md#development-and-verification). No Firebase emulators are used. The current deterministic demonstration runs browser-safe SDK clients and the host in one process against one Pyric backend; the configured Firebase UI runs in the browser. Do not assume a separately launched Pyric browser sandbox and a Node sandbox share state: verify backend identity before using a cross-process setup as evidence.

After packing Pyric, run the deterministic developer/reviewer demonstration from this example with `PYRIC_LOCAL_MODULES=/absolute/path/to/monorepo/.pyric/local/node_modules bun run demo:pyric`. It also checks reconnect, permissions, replay, expiry and shared executor behavior. The application and adapter keep canonical Firebase imports; the development preload supplies the packed Pyric implementation.
