# Firebase Realtime Database bridge

The Firebase transport is opt-in functionality inside `@inbrowser/sandbox`. Install `firebase@^12.12.0` yourself. Root, `/remote`, and WebSocket hosts do not import Firebase. Pyric is used only for development.

```ts
import { createRemoteSandbox } from '@inbrowser/sandbox/remote';
import { createFirebaseRtdbBridgeProvider } from '@inbrowser/sandbox/remote/firebase/rtdb';

const sandbox = await createRemoteSandbox({
  id: 'demo-container-session',
  transport: createFirebaseRtdbBridgeProvider({ database, auth, executorId: 'demo' }),
  requestTimeoutMs: 35_000,
});
await sandbox.runtime.run('echo hello');
sandbox.destroy(); // Detach this client; the remote container survives the grace period.
```

Pass already initialized, signed-in Auth and Database clients from the **same Firebase app**. The caller owns login and credential refresh. Namespace, executor/session/request identifiers and Firebase UIDs currently accept 1–128 ASCII letters, digits, underscores and hyphens. The default namespace is `inbrowserBridge`.

```ts
import { startFirebaseRtdbBridge } from '@inbrowser/sandbox/remote/firebase/rtdb/host';
import { createAppleContainerProvider } from '@inbrowser/sandbox/remote/apple-container';

const bridge = await startFirebaseRtdbBridge({
  database, auth, executorId: 'demo', root: '/work',
  provider: createAppleContainerProvider({
    image: 'inbrowser-firebase:latest', rootedFileSystem: true,
    namePrefix: 'inbrowser-firebase-demo',
  }),
  policy: { run: true, fs: 'rw' },
  stateDirectory: '/absolute/private/host-state/demo',
  reconnectGraceMs: 600_000,
});
console.log(await bridge.status());
await bridge.destroySession('demo-container-session'); // Local administrator action.
await bridge.stop(); // Await container disposal and journal closure.
```

This host opens no HTTP or WebSocket listener. Give each executor its own state directory and provider container-name prefix: startup cleans stale containers owned by that provider. The directory contains a lock and a durable journal, must survive host restarts, and must never be mounted inside the workload. The host uses ordinary Firebase client credentials, not Firebase Admin credentials.

## Provisioning and permissions

The package exports `@inbrowser/sandbox/remote/firebase/rtdb/database.rules.json`. The whole reference file is intended for a dedicated database. For a shared database, merge only its dedicated namespace while preserving unrelated Rules. If you change `namespace`, replace **all** `inbrowserBridge` references in the Rules, including absolute `root.child` expressions. Do not add ancestor `.read`/`.write` grants that bypass these restrictions.

Provision `executors/<executorId>/config/uid` with the executor's Auth UID and `sessions/<sessionId>/manifest` with `ownerUid` and a `members` map whose values are `developer` or `reviewer`. Project administrators provision manifests; attaching does not create membership or choose a container image. The example includes fixtures. Use actual provisioned UIDs when deploying to Firebase; the fixture passwords are only for local Pyric.

| Identity | Allowed operations |
| --- | --- |
| Owner | Developer rights; manage membership; explicit `session.destroy` RPC |
| Developer | Activate/attach, run/cancel, file reads/writes, snapshots and restore |
| Reviewer | Attach to an already active session; read/list/stat, read-only snapshot, observe output/status |
| Assigned executor | Admit requests and write results/events/status |

The host policy is a ceiling on these rights. Runtime feature declarations and client capability overrides do not authorize operations. Only authenticated identity plus the current manifest establish authority; envelope `peer` and payload fields do not.

Rules bind request authors and validate permitted operation names. After scheduling, the executor rereads membership and commits an admission transaction whose Rules check current membership and the request deadline. Cached membership alone cannot admit work. Revocation blocks later admission and new output access; it cannot retract delivered data. Configured Firebase project administrators are trusted; this protocol does not independently sign delegated requests.

Developer `run` grants arbitrary shell execution within the container's OS privileges. It is not a restricted-task API. Apple rooted mode runs commands as UID/GID 1000, requires Python 3 and `setsid`, and performs filesystem RPCs on a dedicated tmpfs workspace mount through a chrooted helper that rejects symlinks, hard-linked files and special files. Custom providers must implement restart cleanup via `cleanupStaleSessions` and containment themselves and declare `fileSystemIsolation: 'rooted'`; the host rejects providers without that guarantee. Images, mounts, root, credentials and provider configuration are exclusively host-owned.

## Delivery and lifecycle

Requests occupy one of 100 session mailbox slots. An immutable record contains the existing envelope as JSON, its author, ID, generation, operation and a 30-second admission deadline. A successful write means **submitted**, not completed. The executor records server-acknowledged admission and durable journal acceptance before invoking the operation; `operations/<id>` exposes accepted/running/terminal phases and the final running admission rechecks membership; the operation may then run for longer than its admission deadline. Terminal responses are separate records. Output events have increasing sequence numbers.

The persistent journal returns recorded results for duplicate IDs and rejects changed contents. Mutations serialize within a session; reads, status and cancellation can proceed while a command runs. Cancellation requests signal the provider; requesting cancellation is distinct from confirmed process exit. Client timeouts do not imply cancellation. There is no exactly-once execution guarantee.

Restart advances the executor generation, disposes stale containers and ends old sessions. Unfinished accepted requests receive an **unknown outcome** response and are never automatically rerun. Do not delete the journal to resolve a retry: inspect the unknown outcome first.

The client subscribes before submission and avoids intentionally queueing offline work. SDK writes interrupted in transit may still reach Firebase after reconnect; expired requests cannot be admitted. Authentication/connectivity loss stops admission. Operations already running may continue. SDK acknowledgement waits are bounded; an acknowledgement timeout reports uncertainty, not successful cancellation.

Attachments renew every 20 seconds and expire after 60 seconds. The container is disposed 10 minutes after its last lease expires (maintenance runs every 20 seconds), on explicit owner/local destruction, or on host shutdown. `sandbox.destroy()` only detaches. Reconnect by creating a new sandbox with the same authorized session ID. Concurrent WebSocket/RTDB attachment and automatic failover are not supported.

Limits: 1 MiB serialized envelope, 100 outstanding mailbox slots per session, 10 MiB retained stream window and 24-hour terminal result retention. The client also caps its pending requests at 100 and asks for reattachment after 10,000 request IDs. `bridge.replay-gap` and `bridge.output-truncated` artifacts expose bounded replay/output loss. Current-generation journal tombstones remain after result cleanup so old IDs cannot execute again. A host crash can lose output that was not acknowledged by Firebase.

Preview/port RPCs are explicitly unsupported. Checkpoints retain the current filesystem snapshot semantics: text files and directory entries, not process state, container images, permissions, symlinks or a transactional snapshot while commands are mutating files. Large snapshots are subject to the envelope limit.

## Development and verification

Use Pyric for local Rules and SDK integration; **do not use Firebase emulators**. Follow `scripts/use-local-pyric.ts`: build the local Pyric checkout, then pack/install artifacts into ignored `.pyric/local`, without committing absolute dependency paths.

```sh
# In the local Pyric checkout:
bun run build
# In this monorepo:
PYRIC_REPO=/path/to/pyric bun scripts/use-local-pyric.ts
PYRIC_LOCAL_MODULES="$PWD/.pyric/local/node_modules" bun run --cwd packages/sandbox test:firebase:pyric
```

The preload maps canonical Firebase SDK imports to packed Pyric SDK implementations at the external SDK boundary. Separate named apps and authenticated owner/developer/reviewer/executor identities share one explicitly owned Pyric sandbox; no bridge executor/provider behavior is mocked by the SDK mapping. The tracking container provider records actual invocation counts. Pyric history exposes Rules denials and listener lifetimes.

Pyric's RTDB evaluator currently visits wildcard validations alongside named fields and validates unrelated existing nodes on writes. The reference Rules use explicit allowed field names and validate runtime UID against the configured executor; these retain default-deny semantics on Firebase. This local evidence is not a live Firebase conformance claim. Pyric's logical offline mode does not reproduce network loss, delayed acknowledgements or process crashes; inject those at the connection/process boundary separately.

The opt-in Apple test uses a real container, verifying file access, rejected symlink escapes, process cancellation and cleanup:

```sh
container build -t inbrowser-firebase:latest -f examples/remote-container-bridge/Dockerfile.firebase examples/remote-container-bridge
INBROWSER_APPLE_TEST=1 bun test packages/sandbox/test/firebase-apple.test.ts
```

Use a dedicated configured Firebase project for live reconnect/contention/abrupt-loss checks. Never point destructive test fixtures at an application database. Firestore, Tailscale, hosted provisioning/login, remote previews and restricted-task execution are outside this release.

Live suite (explicit opt-in; creates and removes a unique test namespace and Auth users, preserving unrelated Rules):

```sh
INBROWSER_FIREBASE_SA=/path/to/test-service-account.json bun test packages/sandbox/test/firebase-live.test.ts
```

The service account is used only by this test fixture for provisioning and custom-token minting. The bridge itself receives signed-in ordinary Firebase clients. The test refuses projects without explicit default-deny root Rules. It checks real SDK reconnects, concurrent submissions, heartbeat renewal, explicit shutdown, and a forcibly killed client; abrupt process-loss coverage is separate from orderly SDK `goOffline()`.

The client reserves one second from admission and lease windows for clock-offset uncertainty. The server still enforces the 30-second admission ceiling and final admission rechecks membership immediately before execution.

Mailboxes use `slot-00` through `slot-99`. The Rules deliberately use a fixed-width character pattern: [RTDB’s regex dialect](https://firebase.google.com/docs/database/security/regex) supports a limited subset of common regex syntax. The live suite explicitly exercises low-numbered slots and forcibly kills a separate SDK client after command execution starts, checking that its side effect runs once and its container remains available.
