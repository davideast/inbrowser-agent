# Threat model and security posture

Status: descriptive. This document records what the code as committed actually
permits, so an embedder can decide where to run it. It is not an aspiration and
not a hardening plan. Every reachability claim cites a file and line, or is marked
**not verified**. No claim here is backed by an adversarial test: the repository has
no hostile-code suite, and `AGENTS.md:3` states hostile-code hardening is outside
the acceptance gates.

The limits guide's one-line summary — "Guest processes are trusted. Workers provide
independent execution, not protection from malicious use of browser globals.
Preview content shares the host origin." ([limits](../guide/limits.md)) — is accurate. The rest of
this document says precisely what that costs.

## 1. Trust boundaries as implemented

There are five principals. By default all five share one browser origin, and
`assetLocation` rejects any asset directory that is not same-origin with its
owning `BrowserContainer` (`src/asset-location.ts:12-21`). Two opt-in
cross-origin boundaries exist:

- With `BootOptions.preview`, preview documents move to their own origins
  ([§6](#6-per-origin-preview)).
- With `SandboxContainer.boot` / `installSandboxHost`, `BrowserContainer` itself
  (along with its Kernel Worker, Process Workers, ServiceWorker and IndexedDB)
  runs inside a dedicated cross-origin runtime host iframe so the parent
  embedder page never shares its origin, DOM, cookies, `localStorage` or
  IndexedDB with guest execution ([§7](#7-cross-origin-sandbox-host)).

Everything else in §1-§5 describes the default same-origin prefix mode.

| Principal        | Realm                                                      | Created by                                          |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| Host page        | Window, cross-origin isolated                              | The embedder                                        |
| Kernel Worker    | Dedicated module Worker, one per container                 | `src/index.ts:258`                                  |
| Process Worker   | Dedicated module Worker, one per guest process/thread      | `src/index.ts:1078`                                 |
| Service worker   | One root-scoped registration per origin                    | `src/index.ts:464-482`, `src/sw.ts:1-10`            |
| Preview document | Window (iframe), host origin, served by the service worker | `src/index.ts:401`, `src/service-worker.ts:188-246` |

### Host page

Full authority. It owns `BrowserContainer`, the kernel Worker's privileged channel,
all IndexedDB records, and every outbound `fetch` the installer makes. Guest code
cannot become the host page.

- Privileged kernel operations reachable **only** from the host channel
  (`src/kernel.ts:724-801`): `mount` (773-782), `snapshot` (734), `restore` (735),
  `attach` (756-771), `remove` (772), `stdin` (736-743), `lookup` (789),
  `resources` (744-755), `hostWatch`/`hostUnwatch` (730-733).
- Host filesystem calls run as pid 0 through the same allowlist as guests
  (`src/index.ts:884-935` → `src/kernel.ts:783-788` → `src/kernel.ts:287-290`).
- `install()` fetches tarballs itself, restricted to `registry.npmjs.org` with
  SHA-512 verification (`src/install.ts:94-99`, `100-101`, `124-125`). The lockfile it
  obeys is read from the container filesystem (`src/index.ts:823-839`), which any
  guest process can rewrite; a guest therefore chooses _which_ npm packages a later
  host-initiated install downloads and mounts, within that host and integrity check.
- Cross-origin isolation is required at boot (`src/index.ts:479-480`) and supplied by
  the embedder's headers (`scripts/serve.mjs:13-15`,
  `examples/embedding/serve.mjs:7-9`). `scripts/serve.mjs:12,19-21,95-97` sets
  `Content-Security-Policy: worker-src 'self' blob:; object-src 'none'; base-uri 'none'`
  on `/kernel.js` and `/process.js`; document and preview `Content-Security-Policy`
  headers remain up to the embedder.

### Kernel Worker

Owns the only mutable filesystem: a single module-level `Volume` per kernel Worker
(`src/kernel.ts:25-26`). One kernel Worker per container means **containers do not
share a filesystem**, and there is no path scoping _within_ a container: any process
may read or write any absolute path the allowlist covers.

- Operation allowlist: 23 `*Sync` methods plus `constants`
  (`src/kernel.ts:183-208`), gated in `filesystem()` (`src/kernel.ts:287-288`).
  Anything else is `ENOSYS`.
- Per-process descriptor table; a descriptor not in the caller's own map is `EBADF`
  (`src/kernel.ts:384-394`, `434-438`).
- The kernel has no notion of a user, mode enforcement for guests, or a chroot.
  permission checks use the **owner bits only**, as Node does for a non-root process
  that owns the file: `access` (`F_OK`, `R_OK`, `W_OK`, `X_OK`), open for read,
  write and append, create, mkdir, rename, unlink, rmdir, `readdir`, path traversal
  (search bit) and the shell's execute check. Group and other bits neither grant nor
  deny, and no root-like bypass is claimed. Every process acts as the owner of every
  file, so this is not access control between guests
  (`src/kernel.ts`, `installOwnerBitPolicy`, `requireWritableParent`, `accessSync`); `umask` reports 0 and cannot be set
  (`src/process.ts:271-275`).

### Process Worker (guest)

Guest code and the runtime's own guest-side modules share **one realm**. The loader
installs guest globals additively (`src/loader.ts:591-595`) and removes nothing; the
only browser global it masks is `WorkerGlobalScope`, set to `undefined` so Node
libraries do not take a worker branch (`src/process.ts:981`). Consequently the guest
keeps the entire `DedicatedWorkerGlobalScope` surface, and can overwrite the
runtime's own handlers, including `self.onmessage` (`src/process.ts:63`, `494`).

What the guest cannot reach:

- Another process's syscall channel. Each process gets a private `MessagePort` and
  `SharedArrayBuffer` transferred at spawn (`src/index.ts:1029-1043`, `1390-1418`),
  installed in the kernel at `src/kernel.ts:687-721`. No registry exposes them.
- Another container's filesystem (separate kernel Worker, `src/index.ts:258`).
- Another process's descriptors (`src/kernel.ts:384-394`).
- Another process's module namespace for _publication_: published URLs must carry the
  guest's own container id and pid (`src/index.ts:1245`).
- `window`, `document`, `parent`, or `navigator.serviceWorker` — none exist in a
  dedicated Worker.
- The privileged kernel operations listed above; `syscall()` dispatch
  (`src/kernel.ts:544-627`) exposes only `stdio.prepare`, `stdin.*`,
  `watch`/`unwatch`, `fs.*`, `listen`, `closeServer`.

### Service worker

One root-scoped registration owns the routes `/__preview__/<containerId>/<port>/…`
and `/__modules__/<containerId>/<pid>/…` (`src/service-worker.ts:8-14`, `74-79`).

- It authenticates the **owner** of a container id, never the **requester**. The
  fetch handler resolves the owning client from its `owners` map (registered at
  `src/service-worker.ts:39-50`), or rediscovers it by broadcasting to window clients
  (`84-122`), then serves the request (`123-124`). There is no check of which client
  issued the request.
- It grants itself no filesystem access; it forwards, size-checks and re-frames.
- It sets `Cross-Origin-Resource-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` on guest replies
  (`src/service-worker.ts:222-223`), and `Cross-Origin-Resource-Policy: same-origin`
  on module sources (`src/service-worker.ts:150`).
- An update never skips waiting; only `activate` claims clients (`src/sw.ts:8-10`).
  Boot refuses to adopt a foreign root-scoped worker (`src/index.ts:449-456`) and
  tears the container down if the controller changes (`src/index.ts:161-164`).

### Preview content

Guest-produced HTML/JS executed as a **first-party document on the host origin**
(`src/index.ts:401`). Nothing in the repository sandboxes it: the three iframes that
exist carry no `sandbox` attribute (`public/index.html:88`,
`public/showcase.html:155-156`, `examples/embedding/main.ts:92-96`).

Therefore preview content has, by ordinary same-origin DOM access, everything the
host page has: `window.parent`, the host DOM, host `localStorage`/IndexedDB, the
service-worker container, and the ability to `fetch` any preview or module URL whose
container id it knows. When `preview(port, { webSocket: true })` is used, the runtime
additionally injects a script into the guest's own HTML response
(`src/service-worker.ts:228-245`) that replaces `globalThis.WebSocket`
(`src/preview-socket.ts:307-329`) and talks to the service worker directly
(`src/preview-socket.ts:114-133`).

## 2. Concrete reachability for guest code

"Guest process" means code running in a process Worker. "Preview document" means
guest-authored content loaded from a preview URL. The distinction matters: the
preview document is strictly more powerful.

| Question                                                         | Guest process                                            | Preview document         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fetch` to arbitrary origins                                     | **Yes** (raw `fetch`); **Configurable** (`http`/`https`) | **Yes**                  | The Worker's `globalThis.fetch` is never removed (`src/loader.ts:591-595`) unless constrained by Worker CSP `connect-src`. Node's `http`/`https` adapter enforces `BootOptions.httpAllowedHosts` / `httpBlockedHosts` / `httpEgress` (`src/browser-http.ts:413`, `440-448`, `849`), failing disallowed targets with `EACCES` before `fetch()` (`tests/resource-quotas.spec.ts`).                                                                                                                                         |
| Reach `window` / `parent` / host DOM                             | **No**                                                   | **Yes**                  | No DOM in a dedicated Worker. Preview URLs are same-origin (`src/index.ts:401`) and no iframe sets `sandbox` (`public/index.html:88`, `public/showcase.html:155-156`, `examples/embedding/main.ts:92-96`).                                                                                                                                                                                                                                                                                                               |
| Read or write IndexedDB directly                                 | **Yes** (global present)                                 | **Yes**                  | The runtime removes no Worker globals (`src/loader.ts:591-595` assigns only; no `delete`/`deleteProperty` of a global exists in `src/`). Database names are fixed constants — `src/snapshot-store.ts:4`, `src/package-cache-store.ts:4`, `src/workspace-store.ts:15` — and record keys are the caller's name with no tenant prefix (`src/snapshot-store.ts:7-16`, `src/package-cache-store.ts:7-16`, `src/workspace-checkpoint.ts:22-31`). **Not verified**: no test in this repository opens IndexedDB from guest code. |
| Register or replace the service worker                           | **No**                                                   | **Yes**                  | `ServiceWorkerContainer` is exposed on `Window` only; the runtime's own registration path runs in the host page (`src/index.ts:435-482`). A preview document is a window on the same origin and can call `navigator.serviceWorker.register`. Host-side damage control exists but is reactive: an externally forced controller change tears the container down (`src/index.ts:161-164`).                                                                                                                                  |
| `postMessage` to the service worker                              | **No**                                                   | **Yes**                  | No container handle in a Worker. `src/preview-socket.ts:114-133` does exactly this from a preview document, and the service worker's message handler accepts any client (`src/service-worker.ts:31-38`, `57-72`).                                                                                                                                                                                                                                                                                                        |
| Enumerate other containers' preview paths                        | **No** (by guessing)                                     | **No** (by guessing)     | Container ids are `crypto.randomUUID()` (`src/index.ts:165`). The route regex accepts any `[\w-]+` (`src/service-worker.ts:12`), so there is no server-side rejection of guesses — only the 122 bits.                                                                                                                                                                                                                                                                                                                    |
| Use a _known_ other container's preview URL                      | **Yes**                                                  | **Yes**                  | The fetch handler resolves the owner from the container id and never checks the requesting client (`src/service-worker.ts:74-124`). A guest Worker is a controlled client of the same service worker, so its `fetch` is intercepted — **not verified** by a test here, but it is the specified dedicated-worker inheritance rule.                                                                                                                                                                                        |
| Read another process's compiled module source (same container)   | **Yes**                                                  | **Yes**                  | `/__modules__/<containerId>/<pid>/…` is answered from `this.processes.get(message.pid)?.modules.get(message.url)` with no check that the requester is that pid (`src/index.ts:193-200`, `src/service-worker.ts:126-165`). A guest knows its own container id: it is embedded in `moduleBase` (`src/index.ts:1414`).                                                                                                                                                                                                      |
| Open a preview WebSocket into another container's guest server   | **No**                                                   | **Yes** (with id + port) | Requires `postMessage` to the controller (`src/preview-socket.ts:120-133`). The host validates only `origin === location.origin`, an existing `webSocket: true` policy for that port, and a 64-socket cap (`src/index.ts:602-668`, notably `623-625`).                                                                                                                                                                                                                                                                   |
| Read files another process wrote, anywhere in the container      | **Yes**                                                  | via preview HTTP only    | One volume per kernel Worker, no path scoping (`src/kernel.ts:25-26`, `287-290`). Host-mounted secrets are readable by every process in that container.                                                                                                                                                                                                                                                                                                                                                                  |
| Read another container's files                                   | **No**                                                   | **No**                   | Separate kernel Worker per container (`src/index.ts:258`).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Use another process's descriptors                                | **No**                                                   | n/a                      | `src/kernel.ts:384-394`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Reach another process's syscall channel                          | **No**                                                   | n/a                      | Private transferred port and SAB (`src/index.ts:1029-1043`, `src/kernel.ts:687-721`).                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `mount`, `snapshot`, `restore`, `checkpoint`, package-cache ops  | **No**                                                   | **No**                   | Host channel only (`src/kernel.ts:724-801`); `syscall()` does not dispatch them (`src/kernel.ts:544-627`).                                                                                                                                                                                                                                                                                                                                                                                                               |
| Read persisted snapshots/checkpoints of _other_ named workspaces | via IndexedDB only                                       | via IndexedDB only       | Keys are unprefixed names in per-origin databases (§2 row 3). The public API offers no enumeration.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Spawn unbounded process Workers                                  | **No** (bounded)                                         | n/a                      | `child.maxProcesses` (default `64`) bounds concurrent live guest processes and `worker_threads` Workers per container, including pending admissions (`src/index.ts:1211-1218`, `src/kernel.ts:1644-1649`), rejecting excess spawns with `LimitError` `EAGAIN` (`tests/resource-quotas.spec.ts`).                                                                                                                                                                                                                         |
| Exhaust memory                                                   | **Yes**                                                  | **Yes**                  | No heap policy exists. `memoryUsage` throws `ENOSYS` (`src/process.ts:268-270`) and `getHeapStatistics` returns only the host page's advisory `jsHeapSizeLimit` captured at boot (`src/index.ts:152-157`, `src/process.ts:665-671`). Byte budgets bound individual buffers, never total residency (`docs/reference/architecture.md`: "peak memory can exceed either byte budget").                                                                                                                                       |
| Exhaust CPU                                                      | **Yes**                                                  | **Yes**                  | Busy loops are a supported demonstration (`README.md:80`). Containment is termination, not scheduling: `worker.terminate()` (`src/index.ts:1465`), and an unacknowledged SIGINT forces termination after 250 ms (`src/index.ts:1445-1448`).                                                                                                                                                                                                                                                                              |
| Ignore SIGTERM/SIGINT                                            | **Yes**                                                  | n/a                      | Signals are ordinary messages to a handler the guest can replace (`src/process.ts:494`, `513-520`). SIGKILL and `kill()` bypass the guest entirely (`src/index.ts:1382-1385`, `1465`).                                                                                                                                                                                                                                                                                                                                   |
| Stall every other process in its own container                   | **Yes**                                                  | n/a                      | One kernel Worker serves all of a container's processes and the host's own filesystem RPCs on a single event loop (`src/kernel.ts:687-721`, `783-788`). Saturating it makes peers' syscalls hit the 5 s poison deadline (`src/protocol.ts:96-104`) and the host's RPCs hit 7 s (`src/index.ts:360-363`).                                                                                                                                                                                                                 |
| Forge host-facing control messages                               | Partly                                                   | n/a                      | The guest owns its Worker's `postMessage`. The host validates shape and ownership: `http-response` must match a pending id owned by that pid (`src/index.ts:1276-1288`); module URLs must carry the guest's own pid (`src/index.ts:1245`); `exit` only settles its own handle (`src/index.ts:1315-1324`); `kill` arrives on the parent's private bridge (`src/index.ts:1380-1386`). No path was found by which a guest names another pid.                                                                                |
| Escape the guest realm into the host realm                       | **No** path found                                        | n/a                      | Everything crossing the boundary is structured-clone data or a `MessagePort`; the loader captures `eval`/`Function` before guest code runs (`src/loader.ts:14-15`) and evaluation stays in the guest realm (`src/loader.ts:569-604`). **Not verified**: no test attempts this.                                                                                                                                                                                                                                           |

## 3. Resource limits: what exists and where it is enforced

Every configurable bound below, and every structural one deliberately left fixed,
is named and located in [docs/reference/resource-policy.md](resource-policy.md), which
`BootOptions.resources` configures.

The runtime is densely bounded — 35 source files raise `E2BIG` — but the bounds are
**transport and buffer bounds**, not tenancy or scheduling bounds. Each one caps a
single operation or queue; none caps aggregate consumption by a guest.

| Category                     | Representative bounds                                                                                                                                                                         | Enforced in                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Syscall transport            | 1 MiB per request and per response, 5 s deadline then channel poisoning                                                                                                                       | `src/protocol.ts:2`, `4`, `89-110`; kernel side `src/kernel.ts:693`, `711-715`                                                                                                       |
| Descriptor I/O               | 64 KiB per message; 32 MiB per operation (default), 64 MiB configurable ceiling; 4,096 open file descriptors (`filesystem.maxOpenDescriptors`, `EMFILE`)                                      | `src/fs.ts:164`, `250`; `src/descriptor-read-limit.ts:3`; `src/kernel.ts:128-137`                                                                                                    |
| Filesystem volume            | 1 GiB aggregate payload bytes (`filesystem.maxTotalBytes`, `ENOSPC`) and 200,000 live inodes (`filesystem.maxInodes`, `ENOSPC`) across reachable links and open descriptors                   | `src/kernel.ts:100-126`, `434-435`, `1852-1856`                                                                                                                                      |
| Filesystem watching          | 4096 registrations per guest process and 4096 host subscriptions; 256 events / 1 MiB of filenames per host subscription                                                                       | `src/kernel.ts:587`, `40`, `62-65`                                                                                                                                                   |
| Filesystem snapshots         | 128 MiB logical bytes, 100,000 entries; restore refused while any process/descriptor/listener lives                                                                                           | `src/snapshot.ts:11-12`; `src/kernel.ts:112`, `122`, `138`                                                                                                                           |
| Module graph                 | 32 MiB per module, 128 MiB and 2048 URLs per process                                                                                                                                          | `src/module-limits.ts:2-3`; `src/index.ts:1491`, `1508-1510`; re-checked in the service worker `src/service-worker.ts:156`                                                           |
| Preview HTTP                 | 1 MiB request and 64 MiB response totals by default (raisable, or unbounded); 1 MiB in flight per direction; 120 s host and 125 s service-worker head deadlines; 15 s reader-silence deadline | `src/http-limits.ts:1-2`; `src/preview-stream.ts` (window arithmetic); `src/preview-fetch.ts`, `src/preview-relay.ts`, guest side `src/http.ts` (`ServerResponse.write`, `dispatch`) |
| Outbound HTTP                | 8 MiB decoded body (64 MiB ceiling), 64 KiB headers, 20 s deadline, 1024 requests per Agent; optional `httpAllowedHosts` / `httpBlockedHosts` / `httpEgress` (`EACCES`)                       | `src/http-response-limit.ts:3`; `src/browser-http.ts:413`, `440-448`, `849`; `src/browser-agent.ts:124`                                                                              |
| Preview WebSocket            | 1 MiB frames/messages, 1024 queued packets, 64 relays per container                                                                                                                           | `src/port-socket.ts:10`; `src/preview-socket.ts:221`, `252-256`; `src/index.ts:829`                                                                                                  |
| Process count                | 64 concurrent live guest processes and `worker_threads` Workers per container (`child.maxProcesses`, `EAGAIN`)                                                                                | `src/index.ts:1211-1218`; `src/kernel.ts:1644-1649`                                                                                                                                  |
| Process input                | 64 KiB packets, 32 MiB unread in the kernel, 32 MiB / 1024 undelivered in the host queue                                                                                                      | `src/kernel.ts:474`, `488`; `src/index.ts:1362`, `95-96`                                                                                                                             |
| Process output               | 1 MiB per host observer (overflow errors the observer, not the guest); 32 MiB aggregate child output; 16 MiB retained tail per stream per host process handle (`child.captureBytes`)          | `src/output-channel.ts:3`; `src/child-process.ts:280-282`                                                                                                                            |
| IPC and threads              | 1 MiB per message; graph caps of 4096 nodes, 65536 edges, 1 MiB aggregate array slots                                                                                                         | `src/ipc.ts:5`; `src/ipc-codec.ts:4-6`                                                                                                                                               |
| Compression and archives     | 32 MiB in/out per Unzip (256 MiB ceiling), 32 MiB + 7 s gzip, 64 MiB install archive                                                                                                          | `src/unzip-limit.ts:3`; `src/gzip.ts:6`; `src/package-archive.ts:3`                                                                                                                  |
| Persistence                  | 128 MiB / 100,000 entries per package cache; 7 s IndexedDB open and transaction deadlines                                                                                                     | `src/package-cache.ts:13-14`; `src/snapshot-store.ts:6`, `src/package-cache-store.ts:6`, `src/workspace-store.ts:29-32`, `83-86`                                                     |
| Shell and startup vectors    | 64 KiB script / 2048 words; 256 exec-argv strings / 64 KiB                                                                                                                                    | `src/shell.ts:29`, `39`; `src/exec-argv.ts:6`, `13`                                                                                                                                  |
| Liveness deadlines           | 7 s kernel RPC, 5 s service-worker handshake and preview lookup, 250 ms forced SIGINT                                                                                                         | `src/index.ts:363`, `416`, `508`, `387-391`, `1445-1448`                                                                                                                             |
| Container-wide serialization | `EBUSY` refusals serialize install, package-cache, checkpoint and restore against each other                                                                                                  | `src/index.ts:211-214`, `690`, `725`, `756`, `770`, `787`                                                                                                                            |

Preview HTTP is streamed, so its memory bound is the in-flight window rather than the
body total. Per exchange and per direction a sender may have at most
`preview.responseWindowBytes` / `preview.requestWindowBytes` (1 MiB each by default) of
body posted and not yet taken by the receiver's consumer; the guest, the host relay and
the service worker each meter this and end the exchange on the first frame beyond it,
so a peer that ignores credit cannot make another realm buffer more. The window is not
a tenancy bound: nothing caps the number of concurrent exchanges, so a guest or a
preview document can hold `exchanges × window` in the service worker; a guest that
ignores `write() === false` buffers in its own Worker up to `preview.responseBytes`,
and without limit once an embedder sets that budget to `Infinity`; and Chromium buffers
a `Response` stream between the service worker and the reading page outside any bound
this runtime controls. Raising or lifting the two totals therefore removes the only cap
on how much data one exchange may move, not on how much it may hold.

Deliberately **unbounded** (no constant exists anywhere in `src/`):

- Wall-clock CPU and V8 heap per guest Worker (up to `child.maxProcesses` live Workers per container). Only termination bounds them.
- Virtual listener registry size — `listen` accepts any free port up to 65535 with no
  per-process or per-container cap (`src/kernel.ts:1255-1267`).
- Number of containers per page.
- Total IndexedDB footprint. Browser quota and eviction are the only limit
  (`README.md:95`).
- Rate or count of raw `globalThis.fetch` calls from guest code outside Node's `http`/`https` adapter (the 1024 cap is per `BrowserAgent`
  instance, `src/browser-agent.ts:124`, and guests need not use an Agent at all).

## 4. What "trusted code only" means for an embedder

Concretely: **the guest code you run has the privileges of your own origin.** Run it
only where you would run first-party code you wrote. Specifically, do not use this
runtime to execute code submitted by end users, on an origin that holds session
cookies, tokens, `localStorage`, or IndexedDB you care about, alongside other
tenants' work, or with secrets mounted into a container filesystem.

### Out of scope by design

These are consequences of the architecture; closing them means changing it.

1. **One origin for everything.** Host page, Workers, module transport, preview and
   persistence all share it. Cross-origin isolation (`src/index.ts:322-323`) exists to
   enable `SharedArrayBuffer`, not to separate guest from host.
2. **Preview content is first-party.** It must be same-origin for the service worker
   to serve it and for `CORP: same-origin` to allow embedding
   (`src/service-worker.ts:222`). Same-origin means full DOM access to the embedder.
3. **Guest code shares a realm with the runtime's guest-side modules.** Additive
   globals (`src/loader.ts:591-595`) mean a guest can patch anything inside its own
   process. Only the kernel's own validation is authoritative.
4. **No filesystem partitioning inside a container.** One volume, no path scoping
   (`src/kernel.ts:25-26`). Process isolation covers descriptors and cwd/env, not
   reachability of bytes.
5. **No CPU or memory scheduling.** Browser scheduling with termination as the only
   control (`README.md:100`, `src/index.ts:1465`).
6. **Storage names are origin-global.** Snapshot, package-cache and checkpoint records
   are keyed by caller-supplied name (`src/snapshot-store.ts:7-16`,
   `src/package-cache-store.ts:7-16`, `src/workspace-checkpoint.ts:22-31`), which the
   docs already state as "shared within a browser origin, not isolated tenant records"
   (`docs/reference/architecture.md:756-757`).

### Merely unimplemented

These could be added without changing the architecture. Their absence today is a gap,
not a decision.

1. **No requester authentication on preview and module routes.** The service worker
   authenticates the container _owner_, never the _client_ asking
   (`src/service-worker.ts:74-124`). Container ids are the only secret
   (`src/index.ts:165`).
2. **No cross-process check on module reads.** Any pid's compiled source is served to
   anyone who asks (`src/index.ts:193-200`).
3. **No virtual listener count quota.** `child.maxProcesses`, `filesystem.maxTotalBytes`,
   `filesystem.maxInodes` and `filesystem.maxOpenDescriptors` now bound process and
   volume counts (`src/index.ts:1211`, `src/kernel.ts:100-137`), while `listen` remains
   uncapped up to port 65535 (`src/kernel.ts:1255-1267`).
4. **No storage-key namespacing.** A container id or embedder-supplied prefix on the
   three IndexedDB key paths would partition records without touching the format.
5. **No per-process path scoping.** The kernel resolves canonical paths already
   (`src/kernel.ts:210-248`); a per-process root prefix would fit that walker.
6. **No document or preview CSP.** `scripts/serve.mjs:12,19-21,95-97` sets
   `Content-Security-Policy: worker-src 'self' blob:; object-src 'none'; base-uri 'none'`
   on `/kernel.js` and `/process.js`, while host-page and preview document CSP headers
   (including `connect-src` for raw Worker `fetch`) remain up to the embedder.
7. **No iframe sandboxing guidance.** Neither the README nor
   `docs/evidence/version-aware-embedding-acceptance.md` tells an embedder to sandbox the
   preview frame; the three in-repo frames do not (`public/index.html:88`,
   `public/showcase.html:155-156`, `examples/embedding/main.ts:92-96`).
8. **No adversarial test suite.** Every claim above is derived from reading the code.

## 5. Cheapest structural mitigations, with honest costs

Ordered by ratio of isolation gained to work required. None of these makes the
runtime a sandbox; each closes one specific reachability listed in §2.

| Mitigation                                                                                                                                                                                                                     | What it buys                                                                                                                                                                   | What it breaks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Namespace the three IndexedDB key paths** with a container or tenant id (`src/snapshot-store.ts:7-16`, `src/package-cache-store.ts:7-16`, `src/workspace-checkpoint.ts:22-31`)                                               | Persisted snapshots, checkpoints and package caches stop colliding across tenants in one origin                                                                                | Existing saved records become unreachable unless a migration reads the old keys. Cross-tenant _sharing_ of a warm package cache — the point of `savePackageCache` — is lost, so cold installs get slower. Guest code that can open IndexedDB directly is unaffected (§2 row 3): this defends against confusion, not against a hostile guest.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Check the requesting client** in the service worker's fetch handler: compare `event.clientId` against the owner client or an owner-issued token, instead of trusting the container id alone (`src/service-worker.ts:74-124`) | A leaked preview URL stops granting HTTP access to a container from unrelated pages, and `/__modules__` stops leaking one process's source to another (`src/index.ts:193-200`) | Preview links become non-shareable: opening one in a new tab or a second window stops working, which is how the showcase and several tests use them. The owner-rediscovery path after a service-worker restart (`src/service-worker.ts:84-122`) needs redesign, because it currently exists precisely to answer requests whose owner is unknown.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Per-process path scoping** in the kernel: give each process a root prefix applied in `resolveEntryPath` (`src/kernel.ts:210-248`) before the allowlist runs (`src/kernel.ts:287-290`)                                        | Host-mounted secrets and other processes' working trees stop being readable by every process in a container                                                                    | Breaks the shared-filesystem premise the runtime demonstrates: npm installing into `/workspace` for Vite to read, `fs.watch` across a tree, and every cross-process visibility test (`README.md:76`). Node tooling assumes absolute paths resolve identically in every process.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Process and listener quotas**: a count cap in `spawnProcess` (`src/index.ts:959`) and in `listen` (`src/kernel.ts:606-618`)                                                                                                  | Bounds fork bombs and port exhaustion; turns an unbounded failure into an `EAGAIN`                                                                                             | Real toolchains spawn deep trees — npm → Vite → esbuild service → workers. Any cap low enough to matter risks failing legitimate builds, and the failure surfaces as an opaque tool error. Does nothing about a single process burning CPU or heap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Cross-origin iframe for preview content** (serve previews from a second origin, e.g. `*.preview.example.com`, and relay through `postMessage`). Opt-in milestone 1 is implemented; see [§6](#6-per-origin-preview).          | Removes the largest single exposure: preview content loses `window.parent`, the host DOM, host storage and the service-worker container                                        | The most expensive item here. The service worker is root-scoped on the host origin and is what _serves_ previews (`src/service-worker.ts:74-79`); a second origin needs its own registration and its own copy of the routing helper. Guest replies carry `Cross-Origin-Resource-Policy: same-origin` (`src/service-worker.ts:222`), which must change. The injected preview-socket bridge resolves assets against the owner's same-origin asset directory (`src/preview-socket.ts:114-133`, `src/asset-location.ts:12-21`) and would need a cross-origin channel. Cross-origin isolation (`src/index.ts:322-323`) constrains what the frame may embed. Relative-asset previews (`README.md:98`) keep working; anything that assumes host-origin cookies or `location.origin` does not. |
| **`sandbox` attribute on the preview iframe** (cheap-looking alternative to the above)                                                                                                                                         | Would remove same-origin DOM access                                                                                                                                            | Does not work as drafted: a `sandbox` without `allow-same-origin` gives the document an opaque origin, and an opaque-origin document is not controlled by the service worker — so the preview has nothing to serve it. `allow-same-origin` restores control and simultaneously restores `window.parent` access, buying nothing. Listed here so it is not mistaken for a quick win.                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Content-Security-Policy on host and preview responses**                                                                                                                                                                      | Constrains where preview content may exfiltrate to, and blocks inline injection paths                                                                                          | Preview responses are guest-authored HTML with guest-chosen inline scripts, and the runtime itself injects an inline `<script src>` tag (`src/service-worker.ts:228-245`). A policy strict enough to matter breaks ordinary guest applications, including the pinned Vite fixture. Constrains egress, never the DOM access §2 grants.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Two things no mitigation on this list changes: guest `fetch` to any origin, and guest
CPU/heap consumption. Both require capabilities the browser does not offer a page over
its own Workers.

## 6. Per-origin preview

`boot({ preview: { origin } })` serves each `(container, port)` from its own origin through a
bridge iframe and that origin's service worker ([architecture](architecture.md#per-origin-preview-opt-in-milestone-1),
design §5(a)). It changes only the **preview document** column of §2.
Guest processes, the host-origin service worker, `/__modules__` and every prefix-mode preview are
as described above.

| §2 row (preview document)                                      | Prefix mode | Origin mode                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                                                                                  |
| -------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reach `window` / `parent` / host DOM                           | **Yes**     | **No.** `window.parent.document` throws `SecurityError`.                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/preview-origin.spec.ts`, "security: …"                                                                                                                             |
| Read or write IndexedDB directly (the host's)                  | **Yes**     | **No** for host-origin storage: the host's `localStorage` key is absent, `window.parent.localStorage` throws `SecurityError`, and `indexedDB.databases()` does not list the host's database. The document has its own origin's storage.                                                                                                                                                                                                                          | same test                                                                                                                                                                 |
| Register or replace the service worker                         | **Yes**     | **Not the host's.** The document's controller is `<origin>/__inbrowser_preview_sw.js` and `getRegistrations()` lists only `<origin>/`. An app's `register('/sw.js')` fetches the script past every worker from the embedder's static server, gets 503 and rejects (`TypeError`); the preview worker and the host's controller stay. An embedder that served such a script would let it replace the preview worker for that origin only (design §8).              | same test; `tests/preview-origin-security.spec.ts`, "an app's register('/sw.js') …"                                                                                       |
| `postMessage` to the service worker                            | **Yes**     | **Not the host's**: it is not a client of the host worker. It can message its own origin's worker, which holds only a port bound to that same `(container, port)`; a `port` message from anything but the bridge document is ignored. A `need-port` posted to the host by the preview document or another origin gets no port. A port taken from the bridge (which the preview can script) is refused for any other container or port, for requests and sockets. | Host worker: same test. Forged messages and port use: `tests/preview-origin-security.spec.ts`; each check failed when its guard was removed (`docs/evidence/tdd-log.md`). |
| Use a _known_ other container's preview URL                    | **Yes**     | **Not through the host's prefix routes**: a request from the preview origin to `<host>/__preview__/<id>/<port>/` does not reach the guest. It can still navigate or frame another preview origin it can name, and that origin's worker would serve it in the same storage partition; it cannot read the response (different origin). **Not verified** for the second part.                                                                                       | Prefix route: same test (`probe=from-preview-origin` never reaches the guest). Second part reasoned.                                                                      |
| Open a preview WebSocket into another container's guest server | **Yes**     | **No**: the socket bridge (on by default) carries sockets only for its own binding, and a `socket` message naming another container or port gets an error; the document cannot message the host worker.                                                                                                                                                                                                                                                          | `tests/preview-origin-security.spec.ts`; `tests/preview-origin-websocket.spec.ts`                                                                                         |
| `fetch` to arbitrary origins                                   | **Yes**     | **Yes**, unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                                                                                                                                                                         |
| Exhaust memory or CPU                                          | **Yes**     | **Yes**, unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                                                                                                                                                                         |

What this adds and what remains:

- **Requester authentication** (§4 "Merely unimplemented" item 1) for origin-mode previews: the
  host answers a bridge only from the iframe it created, at that iframe's origin, and refuses an
  `http` message naming another container or port (`src/preview-bridge.ts`). The port is a
  capability for exactly what its origin could already reach. Prefix routes are unchanged.
- **The bridge is scriptable by the preview.** The preview document and the hidden bridge
  iframe share an origin, so the preview can script the bridge and take its port. That gains
  nothing beyond its own binding. Port issues are capped at 256 per bridge.
- **The preview domain is trusted with the guest port.** Whoever serves the preview origin's
  worker and bridge files receives the port for that `(container, port)` and the container's
  resource policy, and can send that guest HTTP requests, as the preview page can.
- **Unchanged:** `postMessage` from the preview to the host page (the runtime ignores anything
  not from its bridge iframes; an embedder's own `message` listeners must check `origin` and
  `source`); guest `fetch` anywhere; guest process Workers on the host origin with host IndexedDB;
  `/__modules__`.
- **Cross-site deployments** (a separate registrable domain): the preview's worker is partitioned
  under the host's site, so a preview opened in a new top-level tab is not served; observed with
  `ThirdPartyStoragePartitioning` re-enabled (`tests/preview-origin-partitioned.spec.ts`).
- **Cookies** (milestone 2). The runtime jar lives in the host page, one per container and
  preview origin; `HttpOnly` values never enter a realm on the preview origin, and the preview
  document cannot read the jar. Tested: a recorder inside the preview worker sees no message
  carrying an `HttpOnly` value or a `set-cookie` header, and the page sees neither
  (`tests/preview-origin-cookies.spec.ts`, "Set-Cookie and HttpOnly values never reach …"; it
  failed when the bridge forwarded `Set-Cookie`). Script-visible cookies are mirrored into the
  preview origin's own cookie store only where a framed document there can use cookies
  (same-site preview domains); there they are as visible as any first-party cookie of that
  origin, and the browser's own rules apply to them. A `Domain` attribute never widens a cookie
  beyond the preview origin: the jar keeps it host-only and the mirror writes it host-only; a
  guest `Domain=<parent>` cookie reaches neither a sibling preview (its `document.cookie` or its
  guest's `Cookie` header) nor the host page (same spec, "a Domain=<parent> cookie stays on its
  own preview origin"; it failed when the mirror passed the parent domain). Page script can add
  cookies the guest then receives, as in a browser, but cannot override or delete a name the jar
  holds, even a non-`HttpOnly` one (a browser would let it). The SameSite context comes from the
  navigation's referrer and is decided by **origin**, not site, so a page on another origin
  cannot get `Strict` cookies sent, for jar cookies and for page-written cookies alike
  (page-written cookies are filtered by `SameSite` and path; one with a Path narrower than `/` is
  never sent). A cross-site navigation is treated as top-level, so it carries `Lax` cookies on
  safe methods even into a cross-site-framed preview. Differences from a browser:
  [limits](../guide/limits.md).
- **WebSockets** (milestone 2). The bridge script is served by the preview worker on the
  preview origin; `forwardSocket` requires the page origin to equal the bridge's preview origin.
  Tested through a stolen bridge port (`tests/preview-origin-security.spec.ts`, "a socket on a
  stolen bridge port with a forged page origin is refused"): the own binding with the host's, a
  sibling's or a `null` origin gets `error` and never reaches the guest; the own binding with the
  preview origin opens and the guest's upgrade handler runs (positive control). It failed when
  the origin check was removed.
- Only Chromium was run. None of this makes the runtime a sandbox for hostile code (§5,
  closing paragraph).

## 7. Cross-origin sandbox host

Whereas §6 isolates only the **preview document** while keeping `BrowserContainer`,
its Workers, ServiceWorker and IndexedDB on the embedder's own origin,
`installSandboxHost` (`src/sandbox-host.ts:518`, aliased as `serveSandboxHost`) and
`SandboxContainer.boot` (`src/sandbox-client.ts:247`, aliased as
`connectSandboxContainer`) move the **entire runtime** onto a dedicated cross-origin
host origin:

- **Parent embedder (`SandboxContainer.boot(urlOrIframe, options)`)**: runs on the
  application origin (for example `https://app.example.com`), rejects same-origin
  sandbox URLs unless `allowSameOrigin: true` is passed explicitly
  (`src/sandbox-client.ts:75`), creates or attaches a hidden
  `<iframe allow="cross-origin-isolated">`, completes a versioned handshake, and
  exposes an async `MessagePort` RPC handle (`mount`, `fs.*` including `watch`,
  `spawn` with per-RPC deadlines and streaming `stdin`/`stdout`/`stderr`/`kill`/`resize`/`exit`,
  `preview`, `install`, `snapshot`/`restore`, `resources`, `dispose`). `dispose()`
  marks the client closed immediately (`EPIPE` on concurrent calls), coalesces
  concurrent teardowns, and bounds the best-effort host dispose acknowledgement to
  `Math.min(rpcTimeoutMs, 1000)` before closing local ports and removing owned
  iframes (`src/sandbox-client.ts:680-715`).
- **Sandbox host frame (`installSandboxHost(options)`)**: runs on a separate
  cross-origin host (for example `https://sandbox.example-usercontent.com/sandbox.html`,
  or `http://sandbox.localhost:<port>/sandbox.html` in `scripts/serve.mjs:72-126`
  where `allowedParentOrigins` is derived strictly from server configuration rather
  than URL query parameters), validates `event.source === window.parent` and
  `allowedParentOrigins` (`src/sandbox-host.ts:791-797`), caps concurrent sessions
  per host frame via `maxSessions` (default `1`, rejecting excess `sandbox-connect`
  handshakes with `LimitError` `EBUSY` at `src/sandbox-host.ts:836-852`), and boots
  `BrowserContainer`. `mergeBootOptions` (`src/sandbox-host.ts:168-225`) keeps
  privileged host fields (`preview`, `httpAgentMode`, `httpOmitHeaders`,
  `assetBaseURL`, `serviceWorker`) strictly under host control, clamps every client
  resource override via `Math.min(client, hostCeiling)` against `hostBoot.resources`
  (defaulting to `DEFAULT_RESOURCE_POLICY` ceilings when omitted), unions host and
  client `blockedHosts`, and intersects host and client `allowedHosts` via
  `intersectHttpEgressPolicies` (`src/resource-policy.ts:827`) so a parent can only
  tighten—never widen—host policies.
- **Hosting header contract**: for `self.crossOriginIsolated` (`SharedArrayBuffer`)
  to hold inside the cross-origin host iframe when embedded by a `COEP: require-corp`
  parent, the sandbox host origin must serve `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`, and
  `Cross-Origin-Resource-Policy: cross-origin` on both `/sandbox.html` and its
  runtime assets (`scripts/serve.mjs:97-99`).
- **Distinct-host requirement for cookie isolation (RFC 6265)**: HTTP cookies are
  scoped by domain/host and ignore port numbers. Hosting the parent on
  `127.0.0.1:3100` and the sandbox on `127.0.0.1:3102` isolates DOM, `localStorage`
  and IndexedDB, **not** `document.cookie` (nor `Domain=.example.com` parent cookies
  when the sandbox is a subdomain of `example.com`). Deploy the sandbox host on a
  separate registrable domain (or an unrelated local host such as
  `sandbox.localhost` vs `127.0.0.1`) so parent cookies are never sent or readable.
- **Verified in `tests/sandbox-isolation.spec.ts`**:
  - Parent `document.cookie`, `localStorage`, DOM (`window.parent.document` /
    `window.top.document` -> `SecurityError`), and IndexedDB databases are
    unreachable from guest Workers, the sandbox host iframe, and per-origin preview
    iframes, and unauthorized parent origins are refused even if `?parentOrigin=` is
    appended to `/sandbox.html`.
  - Structured errors (`LimitError` `ENOSPC`/`EAGAIN`/`EBUSY`, `ChannelError`
    `ETIMEDOUT`) revive across the cross-origin `MessagePort` with `code`, `kind`
    and `limit` preserved; client attempts to widen unset `DEFAULT_RESOURCE_POLICY`
    limits, inject `preview.origin`, or widen `httpAllowedHosts` are clamped/stripped;
    and `dispose()` completes within `< 1.5 s` even when the host frame is
    unresponsive.
  - Unchanged inside the sandbox origin itself: raw `globalThis.fetch` inside a
    guest Worker remains unshimmed unless constrained by Worker `Content-Security-Policy`
    `connect-src`, and CPU/heap per Worker remain bounded by termination rather than
    preemptive browser scheduling.
