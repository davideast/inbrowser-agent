# Architecture decision: browser kernel POC

Status: accepted for the proof of concept. Package: `@inbrowser/node`.

The host library owns a dedicated kernel Worker and independently terminable process Workers. The kernel owns an in-memory VFS, per-process descriptors, and a virtual listener registry. A process calls synchronous syscalls over its own MessagePort and SharedArrayBuffer response slot. The kernel writes the complete response, atomically publishes completion, and notifies the waiting process; it never needs that blocked process to handle a callback.

The syscall protocol is versioned and size bounded. One call per process can be outstanding. After timeout the channel is poisoned, preventing a late response from being reused. Host requests use asynchronous RPC with bounded lifetimes. Teardown and worker failure must reject pending operations and release registrations.

Guest readFileSync/readFile assemble 64 KiB descriptor reads before decoding text,
with a 32 MiB whole-file limit. This preserves the 1 MiB per-message syscall cap.
Descriptors opened by these helpers close on success or failure; caller-owned
descriptors retain their identity and advance from their current position. The
kernel remains the only mutable filesystem owner. File URL arguments are decoded
to POSIX paths in the process before crossing the syscall boundary.

Guest JavaScript uses the browser engine. A CJS loader reads mounted source via syscalls. ESM uses process-scoped URLs served by the service worker. The loader allocates URLs before walking a graph, rewrites import locations using es-module-lexer, and leaves linking, live bindings, cycles, and evaluation to the browser engine. Package type and import/require export conditions are resolved against the kernel filesystem. CommonJS facades use cjs-module-lexer to detect names, including reexports; they execute through the same CJS cache at evaluation time. Named CJS exports are snapshots while the default export retains object identity.

The host stores immutable compiled module sources, not a mutable filesystem replica. A process waits for the host's answer to a publication without a deadline, so a host page busy in synchronous code delays an import but does not fail it (`tests/module-publication-busy-host.spec.ts`). Publication validates a complete graph before adding any member: each source is capped at 32 MiB, and a process has limits of 2048 URLs and 128 MiB of compiled source (`modules.sourceBytes`, `countPerProcess`, `graphBytes`; the service worker's per-module cap `preview.moduleSourceBytes` is 32 MiB too). None of these sizes a buffer: sources are held as strings. These limits include the small native loading wrappers. Sources disappear with the owning process; responses are not persisted by the service worker. Container ID and PID partition the URL namespace. Registration now happens at boot so process Workers are controlled before their first module import.

The loader installs guest globals only in its process Worker; bootstrap timer bookkeeping retains captured host timers. Nonliteral dynamic import is permitted only in the loader, alongside the existing guest evaluation boundary. A native wrapper's first dependency releases import I/O ownership after the graph links, before guest evaluation. Pending guest promises alone do not retain a process. Entry evaluation that remains unsettled when handles drain exits with status 13; explicit nonzero exit codes are retained. Normal exit uses two queued checks so browser rejection reporting can run first. An unhandled rejection that no listener takes fails the process; see [Process lifecycle events](#process-lifecycle-events) for `exit`, `beforeExit`, `uncaughtException` and `unhandledRejection`. This is a tested browser scheduling policy, not general libuv fidelity.

Guest file URLs identify ESM modules independently of their browser transport URLs. Queries/fragments produce separate ESM instances; filename/dirname resolve against the canonical POSIX VFS path. Each module has a mutable null-prototype metadata object. Metadata resolution can return absent export URLs while actual imports still check existence. Lexer-detected dynamic imports in CJS use the same graph and lifetime machinery. Gate evidence includes concurrent ESM/CJS cache isolation, survivor loading after kill, and fresh-process source visibility. See `esm-acceptance.md` for the requirement mapping. Import attributes/JSON ESM, data URLs, and source/defer imports currently fail explicitly. Established browser builtin implementations may be reused. Node APIs implemented here are a subset. The kernel starts in TypeScript; no mutable filesystem replication or speculative caching.

Preview HTTP is a streamed, flow-controlled exchange of frames through a service worker and a controlled host page; see [Preview HTTP transport](#preview-http-transport). A preview path includes container ID and virtual port. This is HTTP ingress, not a TCP stack, and wire-level fidelity is not claimed. Applications may configure the explicit preview base described below; arbitrary root-relative rewriting and hostile preview isolation are not claimed.

No runtime depends on the almostnode fork. Its probes informed the tests. Express is installed on the build host and copied, with its transitive dependency tree and licenses, to a mountable fixture without source changes. Gate 5 now has an experimental browser registry-lock installer, described below;
the Express acceptance fixture still uses premounted files.

Filesystem constants are copied from the kernel filesystem into each process and shared by fs and fs/promises. Their numeric flags follow the virtual filesystem platform. The module builtin-name inventory is pinned to Node 22.18 for dependency classification; it does not advertise implementation support. HTTP status descriptions use the pinned statuses package.

Guest gzip uses the browser CompressionStream API at its default compression
settings. It retains process lifetime until callback completion, snapshots input,
limits input/output to 32 MiB, and times out after 7 seconds. Native gunzip tests
verify valid gzip framing/checksum and exact payload; compressed byte identity is
not promised. Other compression settings and existing stream constructors remain
explicitly unsupported.

The Vite browser fixture mounts unchanged @rollup/wasm-node 4.63.1 package files
at the rollup dependency path. The manifest records the substitution and source
integrity; generation rejects version mismatch. This is the official Node-facing
WASM build described in [Rollup architecture](https://github.com/rollup/rollup/blob/master/ARCHITECTURE.md),
not Rollup's separate browser interface. Native acceptance uses native Rollup.
The Vite browser fixture also substitutes unchanged esbuild-wasm 0.28.2 at the nested esbuild dependency path, with the same version check and provenance metadata. Its standalone CLI passes version reporting and a TypeScript filesystem bundle/execution fixture; its JavaScript service API uses the guest subprocess and pipe transport described below.

Guest path operations use pinned path-browserify-win32 2.0.1 with per-process
POSIX/Windows objects. Cwd-dependent operations consult the current guest cwd on
every call. Internal filesystem/loader path operations retain path-browserify.
The virtual OS reports platform browser and type Browser. TLS connect and HTTP2
server/session entry points are importable but reject with ENOSYS; no connection
or session compatibility is claimed.

Host spawn accepts node plus an entry file and script arguments, preserving empty
arguments after the entry. Guest util exports the browser text codecs. POSIX tmpdir
queries follow the guest environment. Output streams expose numeric descriptors
1 and 2; general fs access to these descriptors remains outside the implemented
filesystem operations.

Guest `child_process.spawn` now has an initial Node-entry subset supporting
`stdio: ['ignore' | 'pipe' | 'inherit', 'pipe' | 'inherit', 'pipe' | 'inherit']`. The parent sends a versioned startup request
to the host, which creates a distinct process Worker using the same kernel attach
path as public spawn. A per-child MessagePort relays output, startup and exit.
The child retains its parent until terminal stream/close delivery. Startup times
out after five seconds; output the parent retains from a piped stdout or stderr is
limited to 32 MiB in aggregate (`child.outputBytes`; see below for inherited
output). This is a bounded output transport, not full pipe backpressure. Parent termination cancels
its owned subtree; this browser lifecycle policy is not native detached-process
behavior. In-flight attachment rechecks parent existence before Worker creation.
Signals, fork IPC and threads remain unimplemented. This scoped transport supports
the pinned Vite esbuild service; broader process behavior remains a later gate.

Piped child stdin now uses a Writable in the parent and a Readable in the child.
Versioned host-relayed messages acknowledge writes and EOF; a pending write has
no deadline (see below) and is failed by exit cleanup. Guest buffered input is capped at 32 MiB.
This establishes binary delivery and asynchronous callbacks, not native pipe
backpressure. The same input supports asynchronous fs.read on descriptor zero,
with bounded pending requests, offset/length handling and EOF. Descriptor requests
retain only through callback completion; stream consumption retains separately.
Positioned stdin reads and other standard-descriptor filesystem operations remain
unsupported. Public host stdin is not yet exposed.

Inherited child stderr now forwards binary bytes through its parent output, with
child.stderr equal to null. windowsHide accepts booleans and has no console-window
effect in a Worker. Child and pipe ref/unref controls track independent references;
pipe closure removes its reference and a destroyed pipe cannot be re-referenced.
The parent can exit when every child/pipe reference is removed; owned subtree
cleanup still applies. This is not full descriptor inheritance or signal support.
The Vite test observes the same process across up to six five-second preview
windows, within its existing 90-second test budget, to accommodate measured WASM
startup. The host input delivery queue described below allows writes to complete while
the child Worker is busy loading WASM.

Child stdin writes now complete when the host successfully queues their bytes to
the child Worker. The parent waits for that answer without a deadline, as a native
pipe write has none: neither a busy child nor a busy host page fails a write
(`tests/child-stdin-busy-peer.spec.ts`), and the child's exit fails what is still
unanswered with EPIPE. The host tracks at most 32 MiB and 1024 undelivered messages,
validates increasing write IDs, and releases capacity on child delivery replies.
The kernel input queue has a separate 32 MiB unread-data bound. A later guest rejection
emits an error on the parent Writable; acknowledging a queued write does not assert
that the child consumed it. Process teardown owns cancellation of queued delivery.
The busy-child test proves accepted writes can complete before the child handles
messages; explicit limit/error tests cover host overflow and late EPIPE.

Guest crypto.getRandomValues delegates to the bound browser-native method. Native
comparison tests cover in-place integer views, subviews, empty views and byte quota
validation.

The process bootstrap adds base64url output to the realm-local pinned Buffer
prototype, including its locale alias. It delegates ranges to the existing base64
implementation before applying URL-safe characters and removing padding. This
slice does not add base64url decoding or encoding discovery. Guest readdir revives
directory-entry predicates from kernel-supplied mode and restores binary names to
Buffers across sync, callback and Promise APIs. The kernel remains the source of
filesystem metadata; these fixtures do not establish full Dirent object parity.

Guest crypto.hash wraps the existing SHA primitive for one-shot input. The current
native differential fixture covers SHA-256 for strings, Buffer, TypedArray and
DataView byte ranges, encoded/Buffer output and invalid data. Unsupported algorithm
names, including sha/SHA-0, fail explicitly. Vite now registers kernel-backed filesystem watchers.

Guest fs.watch registrations belong to the kernel process record and use the
canonical memfs watcher. Versioned events return through the process port; process
termination closes every registration. Persistent guest watchers retain process
lifetime, with idempotent close/ref/unref. UTF-8 and Buffer filenames are supported;
unsupported options fail explicitly. A process is limited to 4096 registrations.
The public resources().listeners count includes filesystem watchers and HTTP ports.
Tests establish file changes, callback receiver identity, final non-retention,
failed registration cleanup and owner termination; broader Vite mutation coverage
remains Gate 3.

preview(port, { requestPath: 'preserve' }) preserves the external preview prefix in
guest request URLs for applications configured with that base path. Default routing
strips the prefix. The host stores policy by port and owning PID, applies it only
to that owner, and removes it on process termination. Policy persists across server
restarts on the same port within one process. This is explicit application base
configuration, not arbitrary root-relative URL rewriting or preview isolation. The one
rewrite the runtime does make is a root-relative response `Location`; see
[Preview HTTP transport](#preview-http-transport).

fs.realpathSync.native delegates to the canonical realpath syscall wrapper. CommonJS
uses five wrapper arguments; guest globals are installed in the dedicated Worker
realm before entry execution, permitting module-local lexical declarations to shadow
them just as in ESM.

Vite's unchanged fixture now lives under /workspace. Its bundled watcher mishandles
a root self-entry when the project is mounted at '/'; root-mounted Vite is not claimed.
Guest os.homedir reads current HOME strings, with virtual root '/' as the fallback
when absent. It never consults a host account database.

Descriptor reads transfer at most 64 KiB per syscall and copy only returned bytes
into the destination view and offset, with a 32 MiB read bound. Explicit positions
do not move the descriptor cursor: the kernel restores memfs's cursor after these
reads. Null/-1 and omitted positions use the current cursor. Ownership stays with
the caller. Byte-view descriptor writes use the same 64 KiB transport chunks and
32 MiB operation bound; positioned writes preserve the descriptor cursor. The
legacy string-write overload still uses a single bounded syscall.

Preview request bodies default to a 1 MiB total and responses to 64 MiB, enforced in
ServerResponse, the host relay and the service worker. Exact-boundary, overflow and
post-failure responsiveness tests establish these defaults. They are budgets over a
streamed body, not buffer sizes; see [Preview HTTP transport](#preview-http-transport).

ReadStream/createReadStream support owned read-only descriptors, inclusive start/end
ranges, encoding and bounded highWaterMark. Reads use chunks no larger than 64 KiB;
end, error and destruction close the descriptor. The documented options it does not
implement (descriptor injection `fd`, `mode`, `fs`, `signal`, flags other than `'r'`,
and `autoClose`/`emitClose` false) fail explicitly; keys Node does not document are
ignored, as in Node. The stream retains its process
from creation to close, a conservative policy that does not establish native paused
stream lifetime. Range, missing-file and early-destruction fixtures compare Node and
browser behavior and verify descriptor cleanup.

WriteStream/createWriteStream write through owned descriptors: flags (default 'w';
anything the kernel's open accepts), encoding, mode, start (positioned writes),
highWaterMark, signal and string, Buffer and Uint8Array chunks, in Node's event order
(open, ready, finish, close). Writes use the 64 KiB chunked descriptor transport and its
32 MiB bound (`filesystem.descriptorWriteBytes`), which errors the stream with E2BIG;
`cork` batches into one `_writev`. Finish, error and destroy close the descriptor, and
the stream retains its process until close, as ReadStream does. A destroy or abort
during open waits for the open, as Node does. `fd`, `fs`, `flush: true`,
`autoClose: false`, `emitClose: false` and unknown options fail with ENOSYS, because the
kernel has no fsync and descriptor injection is not supported. A read-only descriptor
now fails writes with EBADF, as Node does. FileHandle is read-only here, so there is no
`FileHandle.createWriteStream`. Native differentials cover events, errors, append,
positioned and multibyte writes, pipe, pipeline and promises pipeline.
`fs.WriteStream` is a function constructor, as in Node: callable without `new`,
applicable to an object that inherits its prototype (the graceful-fs subclassing
pattern), and a replaced `open()` is called and awaited through its 'open' or
'error' event (`tests/write-stream-legacy-constructor.spec.ts`).

Whole-file writes (`writeFile`, `appendFile`, their sync and promise forms) send a
payload of at most 64 KiB as one syscall; a larger payload, and any write to a
descriptor target, goes through `openSync` and the chunked `writeSync`, bounded by
`filesystem.descriptorWriteBytes` (`tests/fs-write-file-large.spec.ts`).

`opendir`, `opendirSync` and `fs.promises.opendir` return a `Dir` that lists the
directory once when it is opened (Node reads the host directory in batches, so entries
created or removed after opening may differ). `read`, `readSync`, async iteration,
`entries()`, `close` and their errors match Node (`tests/fs-opendir.spec.ts`);
`recursive: true` fails with ENOSYS.

`cpSync`, `cp` and `fs.promises.cp` (`src/fs-cp.ts`) port Node 22.18's
`lib/internal/fs/cp/cp.js` and `cp-sync.js` onto the existing fs primitives, so every
step goes through the kernel's syscalls and the owner-bit permission policy; no
syscall was added. Node's synchronous form does its path checks and, without a
`filter`, its whole directory copy in C++, which is not in the pinned source tree.
Its behavior was measured against the oracle and is reproduced for files, directories,
symlinks (`dereference`, `verbatimSymlinks`), `force`, `errorOnExist`,
`preserveTimestamps`, `mode`, copying a directory into itself, and file/directory
type conflicts, including its error message texts and error shapes
(`tests/fs-cp.spec.ts`, which compares all three forms with Node). Documented
divergences, none of them tested: Node's native directory copy raises ENOTSUP or EEXIST
(and can abort the process) when a directory, or a symlink, is copied onto an
existing entry of another type; here those nested cases follow the semantics of
Node's JavaScript path (`cp-sync.js`) instead. The `ia32` timestamp warning is not emitted.
A Buffer path is converted to a string for the work itself; the asynchronous forms
still reject it with Node's `path` ERR_INVALID_ARG_TYPE.
`globSync`, `glob` and `fs.promises.glob` (`src/fs-glob.ts`) port Node 22.18's
`lib/internal/fs/glob.js` traversal onto the same primitives. Node matches with
minimatch, which is not a dependency of this project (it is present in `node_modules`
only as a development tool's transitive package, and adding it would be a new runtime
dependency), so `src/glob-match.ts` is an independent implementation of the part of
minimatch that Node's glob consumes: brace expansion (lists, numeric and alphabetic
sequences), `*`, `?`, `**`, bracket classes with POSIX names, extended globs
(`?(`, `*(`, `+(`, `@(`, `!(`), the dot-file rule, and the level-two path
preprocessing. Unsupported syntax fails explicitly: collating and equivalence classes
(`[[.a.]]`, `[[=a=]]`) throw ENOSYS. Matching is case-sensitive, as on Linux; Node on
macOS and Windows matches wildcard segments without case. `exclude` accepts a function
or, as Node 22.18 does, an array of glob patterns resolved against `cwd`. Glob is
stable in 22.18, so no experimental warning is emitted. Node does not document result
order and the order here follows the virtual filesystem's directory order, so
`tests/fs-glob.spec.ts` compares sorted sets. The asynchronous forms reproduce Node's
`TypeError: Cannot read properties of null (reading 'length')` when a `**` pattern
visits a symlink to a file or a dangling symlink (Node reads the failed listing's
length unguarded); the synchronous form treats that listing as empty, as Node does.
Besides the hand-written cases, 260 generated patterns and 400 generated `exclude`
options agree with Node in all three forms (a one-off run of 7,500 other generated
patterns also agreed).

`src/fs-misc.ts` holds the smaller operations, each compared with Node in its own spec:
`mkdtemp` (prefix plus six random characters, mode 0700, `tests/fs-mkdtemp.spec.ts`;
the once-per-process warning for templates ending in `X` is not emitted);
`truncate` and `ftruncate` over a new `ftruncateSync` syscall (extending a file beyond
the 32 MiB `filesystem.descriptorWriteBytes` bound fails with E2BIG because files are
resident, and truncating by descriptor number through `fs.truncate` works without the
DEP0081 warning; `tests/fs-truncate.spec.ts`); `fsync` and `fdatasync` (the filesystem is
memory-resident, so they validate the descriptor and succeed; `tests/fs-fsync.spec.ts`);
`chown`, `lchown` and `fchown` (the filesystem has one owner and every process acts as
it, so keeping the owner succeeds and giving a file away is EPERM, as for an
unprivileged Node process; `tests/fs-chown.spec.ts`); and `link` over a new `linkSync`
syscall (a hard link is a second name for the same memfs node; a source that is a
symbolic link is linked itself, as on Linux, while macOS links its target; a snapshot
stores each name as a separate file, so restoring one breaks the sharing;
`tests/fs-link.spec.ts`); `readv` and `writev` over `readSync` and `writeSync`
(`tests/fs-vectored-io.spec.ts`; the kernel's `readSync` now reports EBADF for a write-only
descriptor); and `openAsBlob` (the file is read when the blob is made, where Node's blob
is file-backed and fails with NotReadableError if the file changes; an unreadable file or
a directory fails up front where Node fails at the first read;
`tests/fs-open-as-blob.spec.ts`). `lstat` and `readlink` resolve symbolic links that are not the
last path component, as the OS does (`tests/fs-lstat-through-links.spec.ts`).
`chmod` no longer changes a file's modification time (memfs stamped it; the OS does
not), which `preserveTimestamps` relies on (`tests/fs-chmod-times.spec.ts`).

Gate 4 adds an experimental opt-in preview WebSocket adapter via webSocket:true.
It is injected into preview HTML before application modules and routes same-host
preview URLs through MessagePorts. A host-owned relay resolves kernel port ownership
and delivers an upgrade request with a Duplex stream to the guest HTTP server.
That socket's `setNoDelay` is a no-op and its `setTimeout` follows net.Socket's idle
timeout (`tests/upgrade-socket-set-timeout.spec.ts`). The guest's unchanged WebSocket package parses and produces actual protocol frames.
One acknowledged packet per direction, byte/count bounds and host-owned teardown
constrain transport resources. As with a native server, a guest busy in synchronous
code never ends a socket: a packet waits without a deadline until the peer reads the
last one, later frames wait in order in the 1 MiB send buffer, and a handshake or
close started meanwhile completes when the guest's event loop turns
(`tests/preview-websocket-busy-guest.spec.ts`). Liveness comes from the peers'
lifetimes, not from deadlines: the host closes a guest's relays when it exits, the
page disposes its sockets on pagehide, the page's 5 s heartbeat is answered by the
host relay (not the guest) and fails a page socket after 15 s without an answer, and
the relay closes after `timers.previewSocketIdleMs` (15 s) without a page heartbeat,
so a busy guest cannot trip either. The only remaining deadline is the closing
handshake's 5 s, armed once the guest has read the page's close frame. A browser
WebSocket drops messages that arrive after its own close(), and so does the adapter. Native/browser exchanges, payload boundaries, owner lifecycle and actual Vite
CSS/component/error recovery pass focused tests; Gate 4 is accepted after full verification and independent review. See
hmr-transport-investigation.md for limits, evidence and remaining work.

crypto.timingSafeEqual now uses the pinned official libsodium-sumo 0.8.4 compiled
WASM crypto_verify_32 primitive through an all-block adapter. Its async factory
initializes after process message handlers are installed and before guest execution;
the supplied bound Web Crypto entropy hook skips its conditional Node fallback.
Each call compares every padded block and clears/frees 64-byte scratch storage.
Native comparisons cover values and validation; these tests do not measure timing.
This addition allows actual Vite token validation to remain intact for CSS HMR.

Input reads now consume a kernel-owned shared queue. Async descriptor reads request
only their requested byte count and retain through callback completion; stream reads
may prefetch into their own Readable buffer and retain until stream end/close. A
completed one-shot descriptor read does not leave a stream reference. Inherited
readers consume the same unread sequence; prefetch already consumed by a stream is
not replayed to another reader.

The experimental install API downloads packages in the host browser context and
stages verified immutable archive contents before kernel mounting. It does not
execute guest source. Every download and decompression reader has a cancellation
signal and timeout; container teardown aborts active installation. Bin entries are
kernel symlinks to unchanged published files. CommonJS resolution canonicalizes
real file paths, and entry format detection uses the real entry while guest argv
retains the supplied alias. See installation-acceptance.md for current limits and
unaccepted full-app requirements.

The full installation fixture records WASM substitutions as npm alias overrides
in a committed v3 lock. Explicit omitOptional:true skips only optional:true entries;
mandatory unsupported platform packages still fail. Tar archives may use a single
leading directory other than package/, as published DefinitelyTyped archives do.
Bin paths normalize equivalent ./ spellings, and lock metadata may supply missing
packed bin declarations, matching native npm-ci alias behavior. Every target still
must be a published in-package file. Two independent browser installs match all
2,490 native published-tree entries and bin targets for this exact lock.

Guest timeout handles now expose ref/unref/hasRef and numeric cancellation identity.
A process-owned registry contains only pending handles; idle checks inspect their
reference flags. Unref does not cancel delivery while other resources retain the
process. Fire/clear removes registry membership, and callback invocation preserves
the handle receiver and arguments. Bootstrap timers continue using captured host
functions. This slice does not establish Node timer phase ordering, refresh, or
interval support. Legacy constants exposes a distinct copy of the kernel's supported
filesystem flags (`crypto.constants` is exposed on `crypto` itself; full OS constant
groups remain outside the legacy `constants` module).

crypto.getHashes returns fresh arrays containing the implemented SHA-1/224/256/384/512
names. Native incremental digest comparisons cover each advertised algorithm;
this deliberately excludes OpenSSL algorithms unavailable in the browser runtime.
os.constants currently provides only the four POSIX errno constants consumed by
npm's copy helper (EEXIST, EISDIR, EINVAL, ENOTDIR). These are numeric constants,
not an assertion of host OS identity or a complete error-number inventory.

An initial outbound HTTP client now supports custom Agent subclasses supplying
Duplex sockets through synchronous return or asynchronous callback. Agent hooks
remain in the request path. It buffers request bodies and response bytes with an
8 MiB body bound, 64 KiB header bound and a 20-second deadline. Each request retains
its process until completion/destruction; constructor failure, response destruction,
agent destruction and request cancellation have native/browser regressions.
Fragmented HTTP/1 responses and bodyless HEAD replies are covered. This slice uses
buffered delivery, rejects request chunking/repeated response headers, and has no
pooling, default TCP/TLS connection or external registry transport. Unimplemented
request options (including auth/signals) and keep-alive fail explicitly.

The timers/promises module currently supplies setTimeout through existing guest
Timeout handles. Abort clears the handle and rejects with AbortError, ABORT_ERR
and the original reason as cause. Completion/cancellation removes the abort listener;
ref:false uses the same non-retention semantics as callback timers. Other promise
timer APIs are not yet provided. HTTP/2 exposes six header/status constants needed
by npm's signature dependencies; HTTP/2 sessions remain explicitly unsupported.

Custom-socket HTTP responses now complete from Content-Length or the final chunk,
without waiting for socket EOF. A chunk decoder incrementally validates framing and
collects trailers; payload storage grows geometrically within 8 MiB. The total wire
response remains capped at 8 MiB plus 64 KiB, and chunk metadata has a separate 64 KiB
cap. Body delivery is still buffered. HEAD, 204 and 304 complete from headers before
transfer coding or advertised body length is considered. Malformed/incomplete chunks
and oversized declarations fail and release the request. Repeated trailers remain
unsupported; request chunking, connection pooling and default TCP/TLS are still absent.

Child stdout now also permits inherit: its public stream is null and binary bytes
forward through parent stdout. Only actual pipes add lifetime references. With no
output pipes, close is queued after exit, retaining the parent through close delivery.
Native/browser evidence covers binary output on both channels, nonzero child exit,
null stream handles and zero remaining workers. Stdin inheritance and the 'inherit' stdio shorthand are now supported as described below.

Input attachment either creates a pipe/EOF source or shares a parent's kernel input
record. Each process has its own reader-close state; closing one inherited reader
does not discard bytes for surviving readers. Versioned readiness events wake local
pending readers; synchronous kernel reads atomically remove bytes. Writes cross the
existing syscall transport in 64 KiB packets. Unread input is capped at 32 MiB and
coalesced into 64 KiB blocks, limiting storage to 513 blocks including a partially
consumed head. The existing host delivery queue and asynchronous write acknowledgments
remain in place, including later delivery failures. Kernel references disappear with
process removal. Standard descriptors are still excluded from resources().descriptors,
which counts the existing owned filesystem descriptors.

Native/browser fixtures cover sequential inherited readers sharing bytes and EOF,
a delayed inherited stream with tiny writes and varied multiblock input, the
stdio:'inherit' shorthand, and all prior input/lifetime/bounds cases. This does not
claim raw terminal behavior or general descriptor injection. The 32 MiB stress case
now takes roughly 15 seconds because input crosses the JSON syscall transport;
throughput optimization remains outstanding.

A scoped sh -c command runs in a separately owned process Worker. The shell parses
one complete command before the existing loader evaluates guest code. Its single
Node command executes in that Worker in place, preserving process/input ownership;
it does not run guest source in the npm parent or host. Parsing supports empty words,
single/double quotes, backslash escapes and concatenated word segments. Scripts are
bounded to 64 KiB of UTF-8 and 2048 words. Lists, pipelines, redirections, comments,
globs, substitutions and variable/environment assignment syntax reject explicitly
before execution. Command names resembling assignments are also currently rejected.
Malformed quotes/escapes exit with status 2. Missing commands exit 127; unsupported
script interpreters exit 126 with ENOSYS.

PATH lookup checks canonical filesystem candidates in order and recognizes the
virtual /bin/node when that path has no mounted file. Selected Node scripts require
an exact /usr/bin/env node or /bin/node shebang; other interpreters/options reject
explicitly. This does not establish POSIX executable-mode enforcement. File/bin
symlinks use the existing loader's canonical entry behavior. Native fixtures verify
argument bytes, binary stdio, cwd-relative entries, environment, nonzero exit, a real
installed semver bin, missing PATH entries and cleanup. child_process accepts explicit
shell:false and an absent/undefined stdioString wrapper field; implicit shell options
and meaningful stdioString values remain unsupported.

Unchanged npm 11.6.2 run dev now starts the real Vite fixture through its existing
vite script and installed bin. The browser bootstraps source+lock packages through
container.install; actual npm ci is not established by this result. The same shared
application assertions run under native npm/Vite with the previously disclosed
browser WASM substitutions. Killing the npm process removes its Vite/esbuild subtree.

The approved heap compatibility boundary forwards the page's browser-reported
jsHeapSizeLimit, captured at container boot, to guest getHeapStatistics().heap_size_limit.
It is an advisory cache-sizing input, not the Worker's measured limit or enforcement.
Invalid or absent measurements throw ENOSYS when queried; other statistics remain
absent. The user also approved Fetch-based outbound HTTP adaptation; exact TCP/TLS
semantics are outside that adapter's contract. See acceptance-targets.md.

The approved browser HTTP adapter accepts absolute URL GET requests through
http/https request and get in default 'socket' mode, while retaining custom HTTP
socket Agent behavior. Booting with httpAgentMode: 'fetch' enables 2-argument and
3-argument (url, options, callback) overloads, standard Fetch methods (GET, HEAD,
POST, PUT, PATCH, DELETE and OPTIONS), AbortSignal cancellation (options.signal),
and a browser Agent scheduler. Fetch mode replaces socket/DNS hooks and schedules
requests using maxSockets per origin and maxTotalSockets overall, with a maximum
of 1,024 owned requests per Agent. The unchanged pinned npm Agent, minipass-fetch,
and make-fetch-happen pass focused native/browser networking tests.

The Fetch-mode adapter buffers up to 8 MiB of outbound request bytes
(http.clientBodyBytes) on body-capable methods and up to 8 MiB of decoded response
bytes (http.responseBytes), allows 64 KiB of serialized request or exposed response
headers (http.headerBytes), and owns a per-request deadline capped at
20 seconds starting when the request is dispatched (excluding Agent queue wait
time). A shorter request timeout is supported. Response
content-encoding and transfer-encoding are removed; content-length describes the
decoded body on body-carrying methods while preserving server Content-Length (or its
absence) on unencoded HEAD responses. Browser Fetch owns TLS, CORS and connection
pooling; credentials are omitted. Redirects, custom TLS/socket controls, bodies on
GET/HEAD, and browser-owned forbidden headers (such as Cookie, Origin, Referer,
Sec-* and Proxy-*) reject with ENOSYS.
No synthetic socket/secureConnect event is emitted. Agent options may retain opaque
caller metadata, but known unsupported transport controls reject. A copied,
validated httpOmitHeaders boot policy omits named headers only for exact configured
origins; the runtime contains no registry-specific header rules. Active cancellation,
AbortSignal abort and Agent destruction abort Fetch and release ownership on request
close, after error delivery. At the original transport milestone, the actual npm-ci case reached missing archive decompression;
Gate 6 remains open. See npm-http-agent-adaptation.md.

process.umask() reports zero, matching the canonical virtual filesystem's unmasked
creation modes. Setting a mask throws ENOSYS; this does not claim configurable
POSIX process masks or host permission isolation.

fs/promises.lstat now wraps the existing canonical lstat syscall and preserves
symbolic-link identity, including dangling links. Like the other Promise wrappers,
it provides Promise settlement around synchronous guest syscalls, not asynchronous
kernel I/O scheduling.

Gate 6 archive decoding uses pinned Pako 3.0.1 inside the process Worker. The Unzip
class decodes one gzip or zlib member synchronously, exposing the handle/chunk seam
used by unchanged minizlib 3.1.0. It also supports the tested Transform completion,
error and public close behavior. Input and cumulative decoded output are each
bounded at 32 MiB; unsupported options, flush modes and additional members reject.
Checksums and truncated trailers produce native error codes. Decoder state closes
on failure; caller input/output views are dropped after each processing call.
Process ownership covers pending completion and error/close notifications without
requiring consumption of buffered output. Other compression classes remain explicit
unsupported operations. Pako's MIT/Zlib notices are in generated distribution notices.

Promise appendFile and symlink wrap existing canonical operations. chmodSync,
callback chmod and Promise chmod now dispatch to the kernel's real memfs mode
mutation; chmod does not establish host permission enforcement between guests.
Native/browser tests cover file and directory modes, symlink following and missing
paths.

Permission checks follow Node for the single guest user, which owns every file it
creates: only the owner bits count (owner read, write, execute); group and other bits
neither grant nor deny, and no root-like bypass is modelled. memfs 4.17.0 ORs the
three classes together and requires write permission for every open, so the kernel
replaces memfs's `canRead`/`canWrite`/`canExecute` with owner-bit predicates and
wraps `Volume.openLink` so a read-only open does not demand write permission, then
adds the unlink and rmdir parent-directory check memfs lacks (`src/kernel.ts`,
`installOwnerBitPolicy`, `requireWritableParent`). `access`, open for read, write
and append, create, mkdir, rename, unlink, rmdir, `readdir` and path traversal then
match native `EACCES` (`tests/fs-access-modes.spec.ts`); the guest shell requires the
owner execute bit (126 for a named file without it, skipped during PATH search).
Errors raised by memfs checks carry `code` and `path` but not Node's `syscall`.
`mount()` entries may be `{ data, mode }` (field names as in snapshot file entries):
`src/mount-entries.ts` validates every entry before the kernel writes any, the kernel
then applies `chmod` after each write, and a bare string or `Uint8Array` keeps the
memfs default mode (0o666). Content never implies an execute bit. Snapshots and
checkpoints already persist file modes, so a mounted mode round-trips
(`tests/mount-mode.spec.ts`). Actual npm ci now advances to missing
fs/promises.open and its FileHandle API; Gate 6 remains open.

utimes, futimes and lutimes (sync, callback, and Promise utimes/lutimes) set
memfs access and modification times. The guest converts times with Node's
toUnixTimestamp rules; an invalid Date is libuv's "omit" and keeps that time.
The kernel canonicalizes paths with its cycle-bounded resolver. memfs stores
times as JavaScript Dates, so sub-millisecond precision is not retained, and
times beyond the Date range throw ERR_OUT_OF_RANGE where Node clamps to the host
filesystem's limit. FileHandle.utimes is not provided.

The subsequent read-only Promise FileHandle slice delegates to canonical readSync
and closeSync, exposes fd/read/close, and rejects write-open before side effects.
Close invalidates the wrapper before descriptor reuse. Tests prove positioned and
sequential reads, buffer identity/offsets, EOF, repeated close, closed-read rejection,
owner exit cleanup and a surviving process reading its still-open descriptor.

Gate 6 is now accepted after independent reviews and full verification: 208 tests
plus standards/build checks pass (6.4m). Actual npm ci clean/stale installs and lock
mismatch rejection pass, alongside the existing npm script/application evidence.
See npm-acceptance.md for the exact scope and disclosures; gates 7–10 remain pending.

Child and thread startup has no deadline, as in Node: the parent waits for the
host's `spawned` or error answer, which the host sends for every start request
after its bounded kernel attach request, so neither a parent nor a host page busy
in synchronous code fails a start (`tests/startup-busy-parent.spec.ts`).

Gate 7's first fork slice reuses spawnProcess ownership and transfers a private
MessagePort from the parent Worker through the host into the child bootstrap.
The host validates and closes rejected transfer requests. Guest send/disconnect
operate on the private JSON channel, independently of stdout/stdin transport.
As in Node, a send completes when it is written to the port: its callback runs on
the sender's next turn, whether or not the peer is busy. When the queue has no room
left for a maximum-size message, later callbacks wait until the peer reads, as
Node's wait while the pipe is full; the window differs from a native pipe buffer. The receiver acknowledges
each message when its event loop reads it (before guest listeners are ready, when
it delivers it); acknowledgements only bound memory (64 unread messages and 8 MiB
per direction; a send past either throws E2BIG) and
let disconnect wait until the peer has everything sent. They carry no deadline: a
peer busy in synchronous code never closes the channel, and its queued messages
arrive in order when its event loop turns. Readiness prevents startup messages
being discarded before guest listeners run. A local disconnect emits 'disconnect'
on the next turn, as in Node, stops delivering later messages, and keeps the port
until the peer has read every accepted send; the peer then emits its own
'disconnect'. Only termination ends the channel otherwise: the parent's process
record stops it when the child exits, is killed or fails, and parent exit removes
the entire descendant tree and its kernel descriptors. Sends the peer never read
are then lost without an error, as Node's are once written; later sends fail with
ERR_IPC_CHANNEL_CLOSED. A protocol violation stops the channel and tells the peer.
Child lifetime references follow message/disconnect listeners and pending
operations.

The native/browser fork tests cover JSON Buffer representation, arguments/env/cwd,
shared files, callbacks versus error events, queued-message drainage, reserved
internal messages and crash/owner-kill cleanup. This is not Gate 7 acceptance.
Worker threads remain unsupported, and the remaining
transfer/shared-memory and termination contracts must pass before advancing.
See fork-ipc-acceptance.md for the current surface and bounded transport limits.

Advanced fork mode is negotiated through validated spawn and boot messages. Its
private graph codec preserves supported binary/value identities and cycles with
copy-at-send semantics. It uses the same acknowledged channel and lifecycle as
JSON. Aggregate array slots are bounded before receiver graph allocation; nodes,
atom visits, nesting and encoded bytes are also capped. This is a documented
semantic subset, not V8 wire-format or backing-allocation fidelity. See
fork-ipc-acceptance.md for types, limits and focused evidence.

Gate 7 now has a first worker_threads slice. A validated thread context travels
through the existing host-owned spawn path into a dedicated process Worker.
Kernel attachment IDs retain independent descriptor ownership; guest process.pid
uses the originating process identity. A separate MessagePort carries structured
clones and ArrayBuffer transfers; SharedArrayBuffer storage remains shared. As in
Node, a thread or parent busy in synchronous code never closes that port: messages
queue and arrive in order when its event loop turns. The receiver acknowledges each
message when it reads it; acknowledgements only bound memory (64 unread messages
and 8 MiB per direction; a postMessage past either throws E2BIG) and let close()
wait until the peer has everything sent. They carry no deadline. Only termination
(exit, terminate, a parent's exit) or close() ends the port; messages the thread
never read are then lost without an error, as natively. The
materializer evaluates accessors once and preserves native transfer-time mutation
semantics within its documented object subset. Online/error/exit events use the
host control channel. terminate waits for host cleanup before resolution. See
worker-thread-acceptance.md for mechanical evidence and remaining API limits.

The combined Gate 7 requirement audit and final full verification now pass:
220 tests plus standards/build checks (6.5m), with independent reviews clear.
Gate 7 is accepted within its scoped API contract; Gate 8 is the next target.

Gate 8 adds a scoped Console class on the same global/builtin object and a Promise
pipeline adapter over the existing pinned stream implementation. Each scheduled
process/browser.nextTick dependency callback now owns a process execution reference
until delivery; this prevents idle exit discarding stream completions while leaving
unresolved promises non-retaining. Guest nextTick's existing microtask behavior is
unchanged. Native/browser tests and independent reviews cover these additions.
Actual Vitest 5.0.0 threads/forks startup currently stops at node:vm; see
vitest-acceptance.md for the oracle and next required evaluator boundary.

Guest exitCode now begins unset. Natural completion maps an unset value to zero,
while explicit process.exit distinguishes omitted arguments from an explicit
undefined, matching the pinned native Node behavior. This lets unchanged CLI
error paths use exitCode ??= 1 without a preexisting zero masking their failure.

Gate 8's scoped vm.runInThisContext parses expression scripts with pinned Acorn
before captured indirect eval executes inside the loader and guest Worker realm.
Program-level declarations/control flow, syntactically present dynamic imports and
unsupported execution options reject before effects. Expressions retain native
completion, strict function and closure behavior. Sources are bounded at 8 MiB;
filename labels are encoded for browser sourceURL. Validated line/column offsets
are advisory diagnostic metadata: raw browser stack positions differ from Node.
See vitest-acceptance.md.

vm contexts are a same-realm approximation (src/vm-context.ts), because a Worker
cannot create a realm synchronously. `createContext` marks the guest object in a
WeakMap (no visible property) and returns it; `isContext`, `runInContext`,
`runInNewContext`, `Script` (`runInThisContext`, `runInContext`,
`runInNewContext`), `createScript` and `compileFunction` (with `parsingContext`)
use it. Context code runs as a direct eval inside a sloppy `with` over a Proxy:
context own and inherited properties are free variables, sloppy undeclared
assignments and top-level `var` initializers write to the context, top-level
function declarations are defined on it before the body runs, strict code gets
Node's ReferenceError, completion values are returned, and `this`/`globalThis`
are a global proxy that is not the context object but reads and writes it. Names
in Node 22.18's fresh-context global list fall through to this realm; other realm
globals (`process`, `Buffer`, timers) are not visible. Source goes through the
same Acorn checks and, in experimental async-context mode, the same compiler as
`runInThisContext`. Divergences, pinned in tests/vm-context.spec.ts: built-ins
are shared (`runInNewContext('Array') === Array`, object literals inherit this
realm's `Object.prototype`, thrown errors are `instanceof Error`); `codeGeneration`
is validated and recorded but not enforced (`eval` and `Function` still work);
`console` is the process console; reading an unknown identifier in sloppy code
yields `undefined` instead of a ReferenceError; a sloppy function called without
a receiver sees this realm's global as `this`; strict functions inside sloppy
context code assign unknown identifiers to the context; function declarations
made by a direct eval inside context code stay local. Shapes whose binding cannot
be kept reject with ENOSYS before effects: top-level `let`/`const`/`class`,
block-level function declarations, declarations in strict scripts,
`DONT_CONTEXTIFY`, `microtaskMode: 'afterEvaluate'`, `importModuleDynamically`,
non-empty `contextExtensions`, code cache data, and run options (`timeout`,
`breakOnSigint`, `displayErrors`), as for `runInThisContext`.
The module builtin additionally exports pinned Node 22.18 isBuiltin classification;
its result does not imply an implemented guest builtin. Actual unchanged Vitest
now reaches missing fs/promises.copyFile. Gate 8 remains active.

Gate 8 now adds canonical copyFile for sync, callback and Promise interfaces. The
kernel alone reads/writes copied bytes, applies source mode bits and preserves
same-inode copies. Its bounded component walk follows symlinks before dot segments,
handles dangling destinations and rejects cycles without poisoning the filesystem.
The guest retains trailing slashes and caller error paths and validates flags before
JSON can erase non-finite numbers. Forced reflinks and nonregular sources reject
explicitly. See vitest-filesystem-investigation.md for the precise contract and
native/browser evidence. The resolver is now shared by copy and unlink, as described below.

os.hostname returns the assigned virtual name localhost, independent of process
environment. It identifies neither the physical host nor a unique container, and
does not establish network reachability. Native behavioral and browser policy tests
plus independent reviews cover the addition. Actual Vitest now reaches missing
fs.statfsSync, so Gate 8 remains active and gates 9–10 remain pending.

fs.statfsSync is now importable and always throws ENOSYS. The virtual filesystem
has no declared disk-capacity model; no total/free block counts are synthesized.
This supports optional API imports without asserting implemented capacity queries.
`fs.statfs` and `fs.promises.statfs` follow the same policy: `fs.md` documents the
`StatFs` fields (type, block size, block and inode counts) with no unavailable value,
and the kernel tracks no capacity, so a fixed block size beside invented counts
would be fabricated. The callback form validates its callback with Node's
`ERR_INVALID_ARG_TYPE` and then reports ENOSYS asynchronously; the promise rejects
with ENOSYS. Both keep Node's arity and `fs/promises` identity
(`tests/statfs-unsupported.spec.ts`).

Promise unlink delegates to the same canonical operation as sync and callback
unlink. The kernel rejects empty and nonempty directories before mutation, using
entry metadata without following final links. Copy and unlink share the bounded
component walker; guest wrappers preserve raw dot segments and trailing slashes,
reject empty strings and retain caller paths in operation errors. Parent symlink
cycles reject after 40 dereferences, while final cyclic links can be unlinked.
The Promise wrapper retains the disclosed synchronous-syscall scheduling contract.
Directory rejection uses virtual EISDIR; native platforms may report EPERM, and
the test explicitly compares that category without claiming errno identity.

Focused native/browser tests and independent reviews cover the new unlink behavior
and unsupported statfs policy. Both actual Vitest pools now fail later during
startup with a TypeError reading includes on an undefined value. Gate 8 remains
active and gates 9–10 remain pending.

Guest process.execArgv now starts as a fresh mutable empty array. This runtime
starts without engine flags; script arguments stay in argv. Native/browser tests
cover export identity, mutation and process isolation, with independent reviews
clear. This adds startup metadata, not engine-flag execution or inheritance.
Actual Vitest now advances to API-token creation; its authentication remains intact.
Full verification passes standards/build and 241 tests (6.9m), with only the two
actual Vitest startup failures at token creation. Gate 8 remains unaccepted.

The subsequent UUID slice binds the actual Worker Crypto.randomUUID before guest
evaluation. No-option calls generate browser-native version-4 identifiers; supplied
options reject explicitly. Actual Vitest now creates its own token and reaches pool
startup. Its first reports contain zero tests, which does not satisfy the gate.

Worker env now accepts string-valued replacement environments or snapshots inherited
values. Entries, including getters, are read once before resource allocation. Startup
vectors cross validated child/boot messages, bounded to 256 strings and 64 KiB. The
supported long flags execute CommonJS preloads before entry, apply custom package
conditions, and enable explicit parent URLs for import.meta.resolve. Unknown flags
reject before execution. Loader evaluation remains inside the dedicated guest Worker;
the host only validates/forwards metadata. Public spawn's entry-and-arguments API is
unchanged. See vitest-pool-startup-investigation.md for exact syntax and evidence.

Fork stdio:'pipe' expands to the existing three pipe channels plus private IPC.
Binary input/output and advanced IPC use their existing ownership/cleanup paths.

Fork and spawn now share one stdio normalization (child-stdio.ts), modeled on Node
22.18.0 and checked against it shape by shape (fork-stdio-shapes.spec.ts). Supported:
the strings 'pipe', 'overlapped' (a pipe), 'ignore' and 'inherit'; a falsy or absent
spawn stdio (pipes); for fork, any non-string non-array stdio, which falls back to
`silent` read for truthiness; arrays of any length whose first three entries are
'pipe', 'overlapped', 'ignore', 'inherit', null/undefined/a hole (pipe), a negative
number (pipe), a descriptor number or an object with a numeric `fd`, with 'ipc' and
'ignore'/null/undefined in any later position. Short arrays are padded with pipes.
Descriptors 0, 1 and 2 name the parent's own streams: in their own slot they are
inheritance, and 1 or 2 in the other output slot routes that child stream to the
named parent stream, including its TTY identity. An ignored output is discarded by
the parent and not counted against the output bound. `child.stdio` has one entry per
configured descriptor. Invalid shapes throw Node's errors: ERR_INVALID_ARG_VALUE and
ERR_INVALID_SYNC_FORK_INPUT (TypeError), ERR_CHILD_PROCESS_IPC_REQUIRED,
ERR_IPC_ONE_PIPE, EINVAL for `{fd: -1}` and EBADF for an unowned descriptor.

Unsupported, rejected with ENOSYS before any child resource exists, although Node
runs them: 'ipc' at index 0-2 (the channel is a MessagePort, not a descriptor, so it
cannot stand in for a standard stream); anything but 'ignore' or 'ipc' beyond index
2; another child's pipe stream as an entry; a parent output stream as child stdin
or the parent's input stream as child output (a file-backed standard descriptor
takes the existing descriptor-alias path instead; that direction is untested);
'ipc' on an sh child; spawn's `serialization` option (fork's is supported). A
non-integer or wider-than-32-bit descriptor is EINVAL where Node aborts. A Node
error in the same array takes precedence over ENOSYS. The pinned list, with the
native observation for each shape, is the last test of fork-stdio-shapes.spec.ts.

A spawn of a node entry with an 'ipc' entry gets the same channel as fork. Both
sides expose `channel.ref()`/`channel.unref()`; `channel` becomes null on
disconnect. A parent's channel holds it until the channel closes, independently of
`child.unref()` and of listeners; a child's channel holds it only while it has
message or disconnect listeners. An explicit ref/unref replaces that rule, except
that accepted sends and a disconnect in progress still complete.

A child's output is relayed through the host while its channel is a direct port.
Each child message and disconnect therefore carries the child's emitted-output
count, and the parent delivers it only after receiving that much output, so a line
written before `process.send` precedes what the parent does on that message, as it
does natively. The wait is bounded by the existing message queue: when the queue
fills behind late output the backlog is delivered out of order instead of closing
the channel, and a child's exit releases whatever is still waiting.

The 32 MiB `child.outputBytes` bound counts only bytes the parent retains: those
delivered into a `child.stdout` or `child.stderr` Readable, stdout and stderr
together, over the child's life. Exceeding it ends the child with `E2BIG`. Bytes of
an inherited output (`stdio: 'inherit'`, `fork` without `silent`, or a slot bound
to descriptor 1 or 2) are relayed to the parent's own stream and do not count, so
a long-lived child that shares its parent's terminal is not ended for logging; the
same holds for an unpiped worker thread's output. They are bounded by the
destination, which is the parent's own output path: when the parent's stdout is a
pipe to the grandparent, the grandparent counts the relayed bytes against the
parent, as it counts the parent's own writes, and a file-backed descriptor is
written directly by the child. The host's process output observers keep their
1 MiB bound and error on overflow. The host's convenience captures
(`ContainerProcess.stdout`, `stdoutText`) are bounded separately, per stream and per
process, by `child.captureBytes` (16 MiB): they keep the most recent bytes, start the
retained text on a UTF-8 character boundary, and report the dropped byte count in
`stdoutTruncatedBytes` and `stderrTruncatedBytes`. The retained chunks are the only
copy; the text is decoded from them. The live streams keep their own bound. An ignored output is
discarded and not counted.

Guest stdout and stderr now each own an EventEmitter instance. Listener limits,
on/once/remove/emit and pipe/unpipe events use the pinned emitter implementation,
allowing worker output to pipe into the parent with end:false. Output delivery and
write callbacks retain their existing semantics; this does not claim full Writable
or terminal behavior. Native/browser checks cover simultaneous stream-state isolation.

async_hooks.createHook is importable and, in the default mode, always throws ENOSYS
whose message ends with "boot with asyncContext: 'experimental' to enable it". No hook object or
async-resource instrumentation is synthesized. This lets optional consumers import
the function but preserves an explicit failure if engine instrumentation is requested.
The timers builtin shares the guest globals' existing timeout/immediate functions
and adds immediate cancellation through the same owned registry. Timer phase ordering
remains the existing browser scheduling policy. `setInterval` uses the same handle
class as `setTimeout`, named `Timeout` as in Node: a handle is registered exactly
while a host timer is armed for it, repeats are scheduled from the start of the
previous run with delays outside 1..2^31-1 coerced to 1 ms, `refresh()` restarts
the full delay, `close()` cancels, and `clearTimeout`/`clearInterval` accept each
other's handles and numeric ids. `util.promisify(setTimeout)` resolves through the
timers/promises implementation.

PortSocket captures browser setInterval/clearInterval before guest evaluation for
its transport heartbeat. Cleanup must not resolve those internal calls through the
guest interval API. It has no delivery deadline.

Guest process.memoryUsage is importable and bindable and returns advisory page-wide
figures (see "process.memoryUsage returns advisory page-wide figures" below);
unchanged Vitest's ordinary pools bind the API without enabling reporting.

ChildProcess exposes initial and final exitCode/signalCode/killed metadata and
supports SIGTERM, SIGINT and SIGKILL. SIGTERM and SIGINT are delivered to the guest
Worker, invoking listeners with the signal name and number or taking the default
exit path; a parent-sent SIGINT is not acknowledged and has no forced-termination
grace timer (unlike a terminal interrupt). SIGKILL
terminates from the host even when the guest does not yield. A true kill return
means the request was queued before an exit was observed, not confirmed OS signal
delivery. Other signals/numeric forms remain unsupported. Host exit cleanup still
owns the process subtree and descriptors; public exits retain numeric status codes.

The pinned stream implementation's actual endEmitted state now backs readableEnded.
Unread buffered EOF and early destruction remain false; no extra scheduling or
stream ownership is introduced. This fixes Vitest waiting for an already-delivered
end event during fork shutdown. Console group/groupCollapsed/groupEnd now maintain
per-instance indentation on both channels, with validated widths from 0 to 1000.
Native/browser regressions and separate reviews cover these runtime slices.

Gate 8 final verification passes all standards/build checks and 262 tests (7.6m),
including both real Vitest pools, successful exit, watch revisions and stop cleanup.
The native Vite port collision was corrected without disturbing the unrelated
service or relaxing assertions; oracle review is clear. Both final independent
reviews report no remaining findings. Gate 8 is accepted within vitest-acceptance.md;
Gate 9 is next.

Gate 9 adds an explicitly inactive AsyncLocalStorage boundary. Construction, with or
without arguments (Node 22.18 ignores them and so does the runtime), getStore and
disable describe the initial disabled state. Activation and context-capture helpers
reject ENOSYS before calling guest code, with a message that ends by naming the
`asyncContext: 'experimental'` boot option; no async hooks or
context propagation are emulated. Unchanged ReactDOM's Node entry can construct its
unused store while renderToString uses the legacy synchronous renderer. Actual
fresh-installed Vite client/SSR builds, raw responses and hydration are tested in
production-acceptance.md; streaming SSR is not established by this result.

Gate 9 final full verification passes all standards/build checks and 265 tests
(8.3m), including production-mode SSR, the strengthened inactive-storage rejection
check and all previous gates. Exact production/SSR file hashes and raw responses
match native using the same disclosed WASM lock. Both final independent reviews
are clear. Gate 9 is accepted within production-acceptance.md; Gate 10 remains.

Gate 10 adds a consumable ESM package entry and emitted public TypeScript declarations.
The host validates a same-origin asset directory before Worker allocation. All
Worker URLs and the optional preview bridge resolve through that directory; the
service worker retains root scope. The packed consumer provides the isolation and
service-worker scope headers. See embedding-acceptance.md for hosting constraints.

Public process handles now expose Web Streams. Piped stdin uses the kernel's
existing owned input queue, so host writes can settle while a guest Worker is busy.
Output observers receive copied bytes and have independent 1 MiB limits; overflow
or cancellation does not stop a guest. Existing convenience output captures remain
lifetime-retained. Exit settles output and errors outstanding input ownership.

Filesystem snapshots are explicit copies, never a second live filesystem. The
kernel walks its canonical volume between syscalls. Restore validates the complete
bounded format, builds a private candidate volume and swaps only when no guest
processes/descriptors/listeners remain. The host validates and tightly copies byte
views before dispatch; the kernel independently revalidates. Failed restores leave
the complete prior tree intact. Named IndexedDB saves resolve on transaction commit;
reads are validated before restore, with deadlines and container teardown aborts.
Only files/directories/modes/link targets persist; restart is explicit guest spawning.
The separate packed app proves two-container streaming, saved reload/restart and
file/port/teardown isolation. Full Gate 10 verification is pending.

## Final ten-gate verification

Full `npm run verify` passes formatting, lint, strict TypeScript, architecture
boundaries, build and all 275 tests (8.4m), including the complete packed-consumer
stream/save/reload/restore/restart flow and every earlier gate. Separate final
oracle/scope and implementation/standards audits found no remaining original
acceptance gap. Gate 10 is accepted and all ten targets are complete within the
linked evidence contracts. Historical progress and TDD chronology deviations above
remain recorded; no broader compatibility or hostile-code safety claim follows from
acceptance.

## Showcase host

The developer workbench at `/showcase.html` is a host consumer of the same public
API. Each tab owns an independent container, its candidate replacement, process
handles, draft text and preview iframe. An operation's AbortController owns setup
and startup; stop cleanup keeps that workspace busy until its captured jobs drain.
Fixture loading accepts an optional AbortSignal, checked before Worker creation.
Named snapshot commits have a visible non-cancellable phase because the public
save API reports transaction completion without exposing a commit abort handle.

The host edits files through public filesystem calls. Rename/delete run small guest
filesystem commands, preserving the kernel as the only volume owner. Fixture build
scripts derive editable Vite/SSR sources from the existing accepted examples.
Reports and previews display actual guest results. This layer adds no execution
fallback, new filesystem owner, or broader Node compatibility contract. See
showcase usage and evidence.

## Dependency-edit filesystem compatibility

Promise readlink delegates to the canonical filesystem, preserving raw link targets
and Buffer encoding through the existing syscall conversion. Its scheduling follows
the other synchronous-syscall Promise wrappers; it adds no background I/O worker.

The kernel handles final symlink entries explicitly during rm and rename because
the pinned backend follows their targets. Removal unlinks the entry, validates
force/recursive flags before mutation, and preserves forced missing-path behavior.
Symlink rename moves the canonical Link, preserving inode and raw target, after
checking destination type and parent access. Cross-directory moves, replacement,
same-path no-op, rejected-destination preservation and directory watcher delivery
have native/browser evidence. No second mutable filesystem or host execution path
is introduced. These are bounded compatibility fixes, not a claim of complete
filesystem option or platform-error fidelity.

## Command-local shell assignments

The shell lexer records whether an assignment name was unquoted and unescaped.
Only leading assignment tokens modify the process-owned environment before command
lookup; quoting in values, empty values and repeated last-wins bindings are supported.
Prefixed PATH affects executable resolution. Own-property definition preserves names
such as **proto** as ordinary bindings. Quoted assignment-looking commands and
assignment-like arguments keep their original roles. Standalone assignment statements
and other previously unsupported shell syntax remain explicit failures pending the
later Gate 13 slices. This establishes command-local bindings, not shell expansion.

## Composed shell commands and pipe closure

The shell parses the complete supported command list before execution. Its runner
starts Node stages in independent owned Workers, joins adjacent child streams and
waits for each stage, using the final pipeline stage for conditional execution.
Lookup failures remain stage-local so later stages can receive EOF and run. Each
stage receives its own command environment.

Guest stdout/stderr endpoints carry separate monotonic SharedArrayBuffer closure
flags. Destroying a parent reader closes that endpoint; inherited descendants share
the same flag. A guest write observes EPIPE through its callback and error event.
This transport state owns no filesystem or descriptor table. Public host output
observers keep their independent cancellation/overflow contract. The bundled stream
library sees the actual guest stdio identities, so pipe EOF does not end stdio.

Closed shell diagnostics distinguish the tested pinned native shell's compound
status141 from direct SIGPIPE termination. Node failure reporting remains best-effort
on closed stderr and still terminates with status1. Signal reporting support here
does not enable arbitrary guest signal delivery or full POSIX shell behavior.

## File-backed stdio and bootstrap version2

The version2 process bootstrap declares its wire version and file-bound stdio
indices. Incompatible process builds reject before guest setup, report EPROTO and
exit through host cleanup. This does not establish the broader asset-coherence or
service-worker coexistence contract reserved for Gate19.

Each kernel process owns a descriptor map from guest descriptors to actual memfs
open files. Stdio aliases share the actual file's cursor and open flags. Closing
one alias removes that ownership only; the kernel closes the file after its last
reference. A separate file-stdio identity set prevents a closed fd from reverting
to pipe/output capture. File input streams and guest filesystem calls use the same
canonical cursor. File outputs use bounded filesystem writes.

Before guest spawn returns, the kernel validates every binding and acquires pending
file references as private aliases in the spawning process's descriptor map.
These aliases use a range disjoint from memfs's descriptors. Child attachment
acquires its stdio references before acknowledgement releases the pending aliases.
Failure, timeout or parent teardown releases ownership through existing process
cleanup. Captured file input does not depend on the parent's live input stream.
Rejected attachments close transferred channels before returning an error.

Shell file redirection opens destinations in source order before executable lookup,
then gives child stages numeric stdio bindings. Earlier file effects are preserved
if a later open fails, matching the tested native shell. The shell closes its own
handles after attachment, leaving child aliases alive. Complete syntax validation
still precedes every open; unsupported here-documents, descriptor duplication and
other descriptor numbers reject explicitly. Guest asynchronous errors report through
their own stderr binding, including file stderr, before process cleanup.

## Public filesystem metadata

The host readdir/stat/lstat methods use the same kernel filesystem RPC as host
read/write operations. Directory listings return string names without an ordering
guarantee. FileStat is validated plain data: type (file/directory/symlink), full
mode bits and size. Stat follows a final symlink; lstat describes the link. File
size measures content bytes, symlink size measures raw target bytes, and directory
size is the virtual backend's value. No inode or timestamp contract is added.
The kernel corrects memfs's zero symlink size using the raw readlink buffer, so
guest and host lstat observe the same canonical metadata.

## Public filesystem watching

`fs.watch(path, { recursive?: boolean })` asynchronously registers a canonical
kernel watcher and returns a `ReadableStream<FilesystemChange>`. Events contain
`event: 'rename' | 'change'` and `filename: string | null`; filenames are relative
to the watched directory. These notifications are hints to re-read the canonical
filesystem, not an ordered mutation journal. Native notification ordering and
multiplicity are not promised. Recursive watching is opt-in.

Host subscriptions have their own ownership map, separate from guest-process
watchers. They count as listeners and prevent snapshot restoration until closed.
`reader.cancel()` waits for kernel disposal; container teardown errors pending
reads with EPIPE. A MessagePort carries versioned events under read-demand credit.
Each kernel subscription buffers at most 256 events and 1 MiB of UTF-8 filename
bytes; a slow consumer exceeding either limit receives E2BIG and loses its
subscription explicitly. The host stream prefetches one event. There is no mutable
host filesystem replica and no helper guest process for watching.

## Persisted npm package cache (Gate 16 accepted)

`savePackageCache(name, { path })` captures the committed download cache under
`path/_cacache`; `restorePackageCache(name, { path })` restores it into a fresh
cache destination. Applications explicitly run unchanged npm with `--cache path`,
then `npm ci --offline` after restore. The npm tool is bootstrapped independently.
These operations do not persist the application filesystem or restart processes.
Named records use a separate origin-owned IndexedDB database, with transaction
completion, timeout, cancellation and database-close paths.

The initial format supports npm cacache content-v2 SHA-512 paths and index-v5.
Both save and restore verify content bytes against path hashes, index SHA-1 line
checksums, SHA-256 key placement and latest-entry content/size references. Logs and
temporary downloads are excluded. Logical bytes are bounded at 128 MiB and capture
entries at 100,000; existing public file-read bounds also apply. Browser storage
quota/eviction still apply. Cache operations acquire a host reservation before
asynchronous work. Competing cache calls, host filesystem mutations, installs,
root spawns and filesystem restores reject with EBUSY; earlier kernel calls
precede the resource check. Existing guest descendants remain runnable while
preflight rejects their live parent, so rejected cache calls do not interrupt
process trees. Finally releases the reservation on success or failure.
This excludes concurrent writers through capture/publication; ordinary kernel
mount does not promise rollback of exceptional partial publication failures.
`removePackageCache(name)` explicitly and idempotently evicts a named persisted
record, completing only after its IndexedDB transaction commits. Other named
records survive. Gate 16 passed all focused acceptance checks and full verification
(357 tests, 18.9m), with independent reviews clear. See package-cache-acceptance.md
for the precise contract and retained limits.

The offline npm tracer also establishes `fs.access` F_OK existence checks through
sync/callback/Promise entry points. Permission-query modes (`R_OK`, `W_OK`,
`X_OK`) answer from the file's mode bits and fail with EACCES
(`tests/fs-access-modes.spec.ts`).
Explicit undefined/null open modes receive Node's default before transport.
Descriptor read callbacks return the original buffer and count, including EOF;
positioned reads at/beyond a regular file's size return zero without moving its
shared cursor.

## Durable workspace checkpoints — Gate 17 accepted

Public checkpoint(name, { startup }) and recover(name) preserve files and declared
Node/shell startup configuration. Recovery returns startup without executing it.
The receipt reports revision, writtenBlobs and reusedBlobs; these count unique
content blobs within a named workspace, not filesystem entries or metadata writes.

One strict IndexedDB transaction owns manifest replacement, new content and
removal of obsolete blobs. Acknowledgement follows transaction completion. Existing
candidate blobs are compared with captured bytes and repaired when missing or
corrupt before publishing the head. Concurrent same-name owners serialize through
that transaction; different names retain independent heads. Names are shared
within a browser origin, not isolated tenant records.

Recovery loads a consistent manifest/body set, enforces logical bounds including
repeated content references, and verifies hashes before canonical kernel restore.
The kernel remains the only mutable filesystem owner. Capture and hashing traverse
the full snapshot; incremental persistence means unchanged content does not issue
new durable blob writes. Modes and symlink targets persist; timestamps, inode
identity and execution state do not. Application-level transactions are not implied
by a coherent filesystem capture point.

Eleven focused browser tests cover forced page closure, uncommitted transaction
interruption, actual quota exhaustion, metadata, write avoidance and concurrency.
Full verification passes 368 tests; the acceptance ledger reports all five checks met. See checkpoint acceptance mapping
for exact claims, evidence and limitations.

## Interactive terminal — Gate 18 accepted

Experimental spawn terminal dimensions opt into TTY identity and host input.
ContainerProcess.resize enqueues validated dimensions for the process Worker;
its return does not acknowledge guest listener execution. A resize during loading
can be visible in the guest's initial dimensions before listeners exist. Caller
dimension objects are copied before asynchronous attachment. Only changed sizes
emit resize on the guest output streams. Ordinary pipe streams keep their existing
non-TTY browser contract.

Focused terminal tests cover input bytes, dimensions, current-size queries,
validation and owner lifetime. The kernel continues owning input buffers, and
guest execution remains in process Workers. Full Gate18 verification passed405
tests (10.5m); all six ledger checks and both independent reviews are clear.

Gate18's subsequent experimental input slice adds kernel-owned cooked line
buffering, DEL/CR handling and Ctrl-C queue discard, plus raw byte delivery and
Worker SIGINT listeners. Native PTY tests use explicit echo-off and LF output
settings. This remains a selected terminal discipline, not full termios or
foreground job-control support.

The process-local readline interface now has native-backed printable-ASCII prompt,
left/right editing, resize redraw, constructor prompt and infinite-delay CRLF
coalescing coverage. It uses the real input stream and terminal mode; it closes
idempotently and removes owned listeners even after input destruction. Nonterminal
readline, configured completion/history and non-ASCII display widths remain
explicitly unsupported in this interface slice. Finite-delay event timing is not
established. The real pinned npm init tracer establishes CLI behavior separately
from authored readline tests.

The npm prompt path also requires crypto.randomBytes. Its implementation captures
the browser cryptographic RNG, fills Buffers in at-most65536-byte requests, and
retains positive-size callback lifetime until callback completion. Zero-size
callbacks run synchronously, matching the observed native contract; positive-size
callbacks use a microtask, without claiming full native event-loop ordering.
Allocations are explicitly capped at32MiB (E2BIG beyond that browser bound).
Tests distinguish native API/timing properties from the browser-specific bound;
statistical smoke checks are not treated as proof of entropy quality.

The scoped Module constructor shares the existing process-local CommonJS cache
and canonical resolver. Constructor parent/children links, assigned-filename
require, standard ancestor node_modules paths and basic _resolveFilename are
native-backed. Custom module.paths search overrides and additional
resolution options are not established compatibility. The CommonJS hook and
compilation subset is documented below. Initial stdout/stderr
writable flags now support actual legacy Stream.pipe consumers. The unchanged
npm11.6.2 init flow passes edited prompts, color, final manifest confirmation,
cancellation and subsequent prompt layout after resize against native execution.

Interactive sh -i creates a readline interface for each prompt and runs commands
through the existing shell parser and process pipeline runner. Its prompt input
reads one byte without prefetch so pasted commands and foreground child input
remain in the canonical queue until their reader owns them. Prompt stderr carries
ANSI editing output; stdout carries command output. Host stdin close sends EOF;
ContainerProcess.kill disposes the terminal owner and its descendants.

Terminal descendants share a device identity and current dimensions, with separate
TTY membership for each inherited descriptor. Pipe and file descriptors remain
non-TTY. Resize reaches live members; threads do not inherit TTY membership.
Cooked Ctrl-C clears queued terminal input and asks the host to signal the published
foreground forest. Workers may acknowledge a handled SIGINT; an unacknowledged
signal forces termination after250ms so a busy guest cannot wedge the terminal.
Repeated input coalesces while acknowledgement is pending and never extends that
original deadline; acknowledged handlers can receive subsequent interrupts.
This deadline is a browser policy, not native scheduling fidelity. Readline in raw
mode receives the control byte and implements its own interface signal behavior.

Pending process admissions capture the device interrupt epoch and recheck it
after kernel attachment, before Worker creation. Threads use ancestor interruption
ownership independently of descriptor identity. A per-shell cancellation fence
blocks later queued stages until an ordered prompt message begins the next command.
Canceled admissions release kernel and port ownership and deliver SIGINT closure.
Idle/busy trees, pipelines, delayed process assets and independent surviving
terminals have focused browser tests. The exact attachment scheduling race is a
review-driven correction; the delayed-asset test exercises a different window.
No full POSIX job control, native SIGHUP parity or hostile-code guarantee is implied.

## Version-aware embedding — Gate19 accepted

Wire version3 adds validated kernel readiness and service-worker ownership
acknowledgements alongside process bootstrap validation. Owners carry the client
identity and validated same-origin asset directory; restart discovery revalidates
version and metadata. Preview WebSocket injection resolves against the owner's
asset directory, independent of the service-worker script's location.

The host binds service messages to one controller and version. An externally forced
controller change tears down its kernel and processes. Standalone runtime updates
do not skip waiting, preserving live old clients until normal activation. Boot
never updates an active registration as a side effect and rejects foreign default
registrations before mutation. Explicit serviceWorker:'existing' mode uses the
application's controller with the exported routing-only helper. The application
retains install/activate, client claim and non-runtime routing ownership. See the
embedding contract and integration example.

Required capabilities reject before Worker allocation. Failed kernel/process
assets and service-worker registration report actionable locations. Platform
registration promises and message handshakes have owned deadlines/cancellation;
late native registration completion cannot revive a failed container. Shared
browser registrations are not unregistered merely to clean one container. Remote
unregister is best-effort so controller failure cannot prevent local disposal.
Focused browser tests cover these policies. Full Gate19 verification passes all
423 browser tests and coding standards/build checks; the bound ledger has six met
gates with independent oracle and implementation reviews clear.

## Experimental Astro import boundaries

The HTTP2 response constructor and descriptor-based TTY ReadStream constructor
are now importable for dependency linking and type discrimination. Both reject
construction with ENOSYS; no associated transport or descriptor implementation
is implied. The existing terminal and HTTP adaptation contracts remain scoped
as above. The Astro starter uses unchanged browser npm and the static-build preview path
documented in examples/astro/README.md. Its live dev server remains unsupported.

## Explicit large-package budgets for unchanged npm

Boot option `httpResponseLimit` bounds decoded bytes buffered per outbound Fetch
response. It defaults to 8 MiB and accepts integer byte limits from 1 to 64 MiB.
`unzipLimit` separately bounds cumulative compressed input and decoded output per
Unzip decoder, defaulting to 32 MiB and accepting 1 byte through 256 MiB. Both
policies propagate to process Workers and descendants. These are explicit host
resource policies, not Node options or total heap limits. HTTP responses and each
Unzip processing call still buffer output; peak memory can exceed either byte
budget, particularly with concurrent downloads. No streaming-memory claim is made.
The unchanged Next npm tracer opts into 64 MiB HTTP and 256 MiB Unzip budgets.
The direct registry installer's archive limit is unchanged.

`descriptorReadLimit` permits an explicit per-call descriptor read budget up to
64 MiB, preserving the 32 MiB default and separate 32 MiB whole-file limit.
Each accepted read still crosses the kernel in at most 64 KiB messages. The npm
cache reader requests up to 64 MiB per call, so the Next fixture selects this
budget alongside its HTTP and Unzip budgets. Like those policies, it propagates
through the host's common process admission path to descendants.

### Browser CPU information

`os.cpus()` returns a fresh empty array because browser Workers expose no per-core
model, frequency or CPU accounting information. This uses Node 22.18's documented
unavailable-information result, not synthetic core records or host inventory.
`os.availableParallelism()` continues to return the browser's advisory capacity.

### Browser OS identity, memory and network

Where `os.md` documents an unavailable result, the browser returns it:
`networkInterfaces()` is a fresh `{}` ("interfaces that have been assigned a
network address", 267), `loadavg()` is `[0, 0, 0]` (Unix-specific; 233-247),
`EOL` is `'\n'` and `devNull` is `'/dev/null'` (the POSIX values, 20-31 and
156-169; the virtual filesystem has no device nodes, so opening `devNull` fails
ENOENT). `endianness()` is measured from the engine's typed-array layout.
`arch()` equals a new `process.arch`, which is the string `'browser'`: like
`process.platform` it names this runtime, because `os.md` lists only compiled-binary
architectures (48-61) and no host CPU is probed. `totalmem()` forwards
`navigator.deviceMemory`, which browsers round to a power of two and cap at 8 GiB,
as an advisory total; it throws ENOSYS when the host reports none. `freemem()` is
advisory too: `totalmem()` minus the host page's current used heap (the same relay
as `v8.getHeapStatistics()`), clamped to `[0, totalmem()]` and returned as an
integer. It is an upper-bound estimate, because it ignores every consumer other
than the page's JS heap; it throws ENOSYS when `navigator.deviceMemory` is absent
or invalid or the page reports no valid heap pair. `release()`, `version()`,
`machine()`, `uptime()` and `userInfo()` have no browser source and no documented
unavailable value, so they throw ENOSYS. This is a policy for a browser host, not
host-inventory conformance.

### process.memoryUsage returns advisory page-wide figures

`process.memoryUsage()` returns Node's five keys in Node's order (`rss`,
`heapTotal`, `heapUsed`, `external`, `arrayBuffers`) as safe non-negative integers.
`process.md` (2807-2862) documents no unavailable value, and no browser API reports
a process resident set size (`performance.memory` does not exist in Workers;
`measureUserAgentSpecificMemory` is asynchronous, page-only and slow), so the
values are advisory and built only from what the host page measures:

- `heapTotal` and `heapUsed` are the page's `totalJSHeapSize` and
  `usedJSHeapSize`, sampled on every call through the same synchronous relay as
  `v8.getHeapStatistics()` (`src/page-memory.ts`). Two calls make two samples, so
  they agree only while the page's figures do not change between them.
- `rss` equals `heapTotal`. It is a documented lower bound, not a resident set
  size; real RSS also includes code, native memory and every other isolate.
- `external` and `arrayBuffers` are `0`, meaning "not measured", not "none in use".
- `process.memoryUsage.rss()` returns the same `rss` figure.

All figures are page-wide: every guest process on the page reports the same
numbers, not its own, and Chromium quantizes `performance.memory`, so small changes
may not show. When the host provides no valid pair (no `performance.memory`, or
non-integer, negative or inconsistent values) both forms throw ENOSYS; no constant
is substituted. This unblocks unchanged Next, which calls `os.freemem()` and
`process.memoryUsage()` unguarded during dev-server startup and on every request.

### process.constrainedMemory, availableMemory and resourceUsage

`process.constrainedMemory()` returns `0`, `process.md`'s documented value when "there
is no such constraint, or the constraint is unknown" (1144-1166): the browser exposes
no OS-imposed process limit, and the boot-time heap advisory is a V8 heap bound, not
one. `process.availableMemory()` follows `uv_get_available_memory`, which with no
known constraint is "identical to `uv_get_free_memory()`": it is `os.freemem()`'s
advisory (one shared function), page-wide and an upper bound, and it throws ENOSYS
where `os.freemem()` does. `process.resourceUsage()` throws ENOSYS. Every field maps
to `getrusage` (3672-3719); seven are "not supported by any platform" and natively
`0`, but `userCPUTime`, `systemCPUTime`, `maxRSS`, page faults, block I/O and context
switches have no documented unavailable value and no browser source, and elapsed
`performance.now()` time is not CPU time. Returning the seven documented zeros beside
invented or omitted CPU fields would be a partial or fabricated record, so the call
fails as a whole. `tests/process-resource-usage.spec.ts` compares function identity and
integer shape with the pinned binary and asserts these values separately.

### v8.getHeapStatistics

`heap_size_limit` stays the boot-time page advisory. `total_heap_size` and
`used_heap_size` (`v8.md`, "v8.getHeapStatistics()", 168-250) come from the host
page's `performance.memory` sampled at call time, relayed synchronously: the
process Worker posts a `SharedArrayBuffer` to the host and blocks in `Atomics.wait`
while the free page thread samples and releases it (`src/page-memory.ts`); the
kernel is not involved. The figures are real, current and page-wide, not the
guest Worker's, and Chromium quantizes them. A pair that is absent, non-integer,
negative or inconsistent (`used > total`) is omitted, leaving only the limit. The
other eleven documented fields have no browser source and stay absent. This lets
Next's memory-restart guard (`used_heap_size > 0.8 * heap_size_limit`) run, with
page-wide rather than per-process input.

### process.features

`process.features` has Node 22.18's twelve members in native order. Each
`process.md` entry (1945-2084) describes the Node.js build, and this runtime has
none of those capabilities, so every value is `false`: no inspector, libuv, TLS,
IPv6 sockets, `require()` of ES modules, builtin code cache or debug build.
`uv` and `ipv6`, which the docs call "always true", describe real builds. The
pinned binary reports `typescript` as `"strip"` by default and `false` under
`--no-experimental-strip-types`; the runtime never strips or transforms types, so
it returns that documented `false`, and the differential test compares against the
flagged native run.

### process metadata

`src/process-metadata.ts` gives each member a stated source. `process.release` is the
identity of the release the runtime reports as `process.version` (`name: 'node'`,
`lts: 'Jod'`, and the v22.18.0 source and headers tarball URLs, which equal the pinned
binary's). `process.config` describes the configure options of the compiled
executable (`process.md` 1078-1126); none was compiled, so both documented sections,
`target_defaults` and `variables`, are empty, frozen as in Node.
`process.allowedNodeEnvironmentFlags` is Node's frozen `NodeEnvironmentFlagsSet`
(normalizing `has`, no-op `add`/`delete`/`clear`) holding the one flag this runtime
reads from `NODE_OPTIONS`, `--unhandled-rejections`; Node's 267 flags would claim
options the runtime ignores there. `process.moduleLoadList` is empty: no Node
internal binding or builtin source is ever loaded. `process.domain` is `null`, Node's
value with no active domain; there is no `domain` module. `process.title` starts as
the runtime's program path, `process.execPath` (`/bin/node`), and coerces assignments
to strings; there is no `ps` entry to rename. `process.debugPort` starts at `9229`,
the documented default inspector port (`cli.md`, `--inspect-port`), and validates
assignments with Node's `ERR_OUT_OF_RANGE` rule; it is a setting only, since no
inspector can be enabled ([Inspector](#inspector-no-active-inspector)).
`tests/process-metadata.spec.ts` compares assignment, coercion, validation, freezing
and Set behavior with the pinned binary and asserts the values separately. Natively,
`title` and `debugPort` are engine accessors that report as data properties; here they
are ordinary accessor properties.

### process.report (partial diagnostic report)

`src/process-report.ts` follows Node 22.18's `lib/internal/process/report.js` and the
reportVersion 5 format. A report holds three sections. `header` keeps the fields
this runtime can state about itself: event, trigger, filename, the dump time (local
time with Node's literal `Z`) and millisecond stamp, `processId`, `threadId`, `cwd`,
`commandLine` (`execPath`, `execArgv`, `argv`), `nodejsVersion`, `arch` and
`platform` (both `'browser'`, as in [Browser OS identity](#browser-os-identity-memory-and-network)),
`componentVersions` (`process.versions`) and `release`. `javascriptStack` is the
first line and trimmed frames of `err.stack`, or of Node's `ERR_SYNTHETIC` error
captured at the caller, with `errorProperties` from the error's own enumerable keys.
`environmentVariables` is `process.env`, absent under `excludeEnv`. Omitted, because a
Worker has no source for them: the `javascriptHeap`, `nativeStack`, `resourceUsage`,
`uvthreadResourceUsage`, `libuv`, `workers`, `userLimits` and `sharedObjects`
sections, and the `wordSize`, `osName`, `osRelease`, `osVersion`, `osMachine`, `cpus`,
`networkInterfaces` and `host` header fields. A consumer that requires one sees it
missing, not invented. `writeReport` writes the same report into the virtual
filesystem (under `directory`, else relative to the cwd), to `stdout` or to
`stderr`, prints Node's `Writing ...`/`completed`/`Failed to open ... (errno: N)`
lines, and returns the name or `''`; the generated name uses Node's
`report.<date>.<time>.<pid>.<thread>.<seq>.json` pattern. The pretty form is
`JSON.stringify` with two-space indentation and Node's leading newline, not Node's own
writer byte for byte. Option setters validate as Node does; `compact`, `directory`,
`filename`, `excludeEnv` and `signal` are kept (`excludeNetwork` is kept with nothing
to trim). `reportOnFatalError`, `reportOnSignal` and `reportOnUncaughtException` stay
`false`: enabling one throws ENOSYS, because no fatal-error hook, `SIGUSR2` delivery or
report-on-exception path exists here. `tests/process-report.spec.ts` compares header
identity, stack, environment, files, return values, stderr lines and validation with
the pinned binary, and asserts the section and field lists separately.

### process.loadEnvFile, getBuiltinModule, ref, unref and abort

`process.loadEnvFile(path = './.env')` reads the file from the virtual filesystem and
sets each variable the environment does not already have. `src/env-file.ts` ports
Node 22.18's `Dotenv::ParseContent` with its observable quirks (trimming crosses
newlines, so `KEY=   ` takes the next line; an indented `# x=y` right after a quoted
value is read as a key; unquoted values end at `#`; only double quotes expand `\n`);
its cases are pinned to the native binary's output. Paths accept a string, `Buffer`
or file `URL` with Node's validation, and a failed open carries `syscall: 'open'`.
`process.getBuiltinModule(id)` validates `id` and returns, for an id `module.isBuiltin`
accepts, the same object `require` returns, independent of `require.cache`; a
non-builtin gives `undefined`. A Node builtin this runtime does not implement (for
example `cluster`, `node:test`) throws ENOSYS as `require('node:<id>')` does,
because `undefined` would claim it is not a builtin. `process.ref` and `process.unref`
follow `per_thread.js`: the `Symbol.for('nodejs.ref'/'nodejs.unref')` method first,
then `ref()`/`unref()`, nothing for `null`, `undefined` or a value without either.
`process.abort()` posts status 134 with signal `SIGABRT` and parks the thread, so no
`exit` listener runs and a parent sees `exit` with `(null, 'SIGABRT')`; the host and
`child_process` accept that signal. Natively it also prints native and JavaScript
stack traces and may write a core file; a Worker has neither, so it prints nothing.
In a worker thread it throws `ERR_WORKER_UNSUPPORTED_OPERATION`, as in Node.
`tests/process-builtins.spec.ts` compares all of these with the pinned binary (for
`abort`, stdout and status only).

### crypto.webcrypto, crypto.subtle, KeyObject, pbkdf2 and one-shot sign/verify

`src/builtins/crypto.ts` assembles the guest `crypto` module. `crypto.webcrypto` is the
process Worker's own `globalThis.crypto` and `crypto.subtle` its `subtle`, the
identities Node 22.18 has. Every WebCrypto operation is the browser's: digests, HMAC,
AES-GCM, PBKDF2 and HKDF results equal the pinned binary's byte for byte in
`tests/crypto-webcrypto.spec.ts`, and ECDSA, ECDH, Ed25519 and RSA-PSS key generation
are compared by round trip; failures are the browser's `DOMException`s
(`NotSupportedError`, `OperationError`, `SyntaxError`), which Node also uses. Because a
pending guest promise does not keep a process alive and WebCrypto settles off-thread,
`installSubtleCryptoKeyCapture` (`src/crypto-keys.ts`) replaces all twelve
`SubtleCrypto.prototype` methods once per Worker, keeping their names and lengths, to
hold the process until settlement, lazily materialize synchronous `KeyObject#toCryptoKey`
handles via native `importKey`, and capture produced key material across `importKey`,
`generateKey`, `deriveKey` and `unwrapKey` (including paired public keys on
non-extractable asymmetric keypairs).

`KeyObject` (`SecretKeyObject`, `PublicKeyObject`, `PrivateKeyObject`), `KeyObject.from`,
synchronous `KeyObject.prototype.toCryptoKey`, `createSecretKey`, `createPublicKey`,
`createPrivateKey`, and `util.types.isKeyObject`/`isCryptoKey` parse and encode canonical
DER/PEM (`spki`, `pkcs8`, `pkcs1`, `sec1`, including compressed X9.62 points over
`P-256`, `P-384` and `P-521`) and JWK synchronously (`src/crypto-asn1.ts`,
`src/crypto-keys.ts`, `tests/crypto-keys.spec.ts`); `createHmac` accepts
`SecretKeyObject` and `CryptoKey`, while `hkdf`/`hkdfSync` accepts `SecretKeyObject`.
`crypto.pbkdf2` (`src/crypto-pbkdf2.ts`, `tests/crypto-pbkdf2.spec.ts`) uses
`crypto.subtle` (`PBKDF2` `importKey` + `deriveBits`) for non-empty
`sha1`/`sha256`/`sha384`/`sha512` derivations and falls back to `hmac` for `pbkdf2Sync`,
`sha224` and zero-length passwords, rejecting `keylen > 268,435,455` (`0x0fffffff`) with
`E2BIG` (`LimitError`) so `keylen * 8` never overflows WebIDL 32-bit bit counts.
Asynchronous `crypto.generateKey` (`hmac`, `aes`), `crypto.generateKeyPair` (`rsa`,
`rsa-pss`, `ec`, `ed25519`, `x25519`), and one-shot callback `crypto.sign`/`crypto.verify`
(`src/crypto-sign.ts`, `tests/crypto-sign.spec.ts`, with `crypto.constants`, Ed25519,
RSA PKCS#1 v1.5, RSA-PSS including RFC 8017 `RSA_PSS_SALTLEN_AUTO` recovery, and strict
canonical DER / IEEE P1363 ECDSA) retain the process through callback settlement.
Differences and explicit boundaries: the WebCrypto algorithm set is Chromium's, so
`Ed448`, `X448`, `DSA`, `DH` and `secp256k1` reject (`NotSupportedError` in WebCrypto,
`ENOSYS` in `crypto`), an exported WebCrypto JWK uses Chromium's sorted member order, and
synchronous `generateKeySync`/`generateKeyPairSync`, synchronous 3-arg/4-arg
`sign`/`verify`, encrypted PEM/passphrase keys, and synchronous `.export()` on
non-extractable WebCrypto keys fail with `ENOSYS`.

### Guest stream module and native read retention

The guest `stream`, `stream/promises` and the runtime's own stream classes (file read and
write streams, HTTP, child stdio, zlib, Unzip, ports) use readable-stream 4.7.0's full
module (`readable-stream/lib/stream.js`; the package's `browser` entry exports a reduced
object). It replaced stream-browserify 3.0.0 over readable-stream 3.6.2. The library
mirrors Node 18.19.0; `src/stream-module.ts` applies the Node 22 surface (64 KiB default
byte high-water mark through the library's own setter, `duplexPair`, `_isArrayBufferView`,
no `asIndexedPairs`, rejection handlers keyed by `Symbol.for('nodejs.rejection')`, function
names the bundler had suffixed) and keeps the `Readable.toWeb`/`fromWeb` port; the
library's `Writable`/`Duplex` web adapters, which ship without an adapter module and fail
with an internal TypeError, are removed. The swap removed runtime patches the older
library needed: the predicate port and the `installStreamState` state hooks
(`errored`, `errorEmitted`, `dataEmitted`, `readableDidRead`, `readableAborted`), the
`readableEnded` accessor, the Promise `pipeline` adapter (`stream/promises` is now the
library's, so `pipeline` accepts options and generators as Node's does), the private
`errorEmitted` reset in the file write stream, the `closed` assignments there, and Unzip's
pre-emptive destroy and post-destroy push guard. Differences that remain are listed in
`docs/guide/limits.md`.

Native Blob reads and Response/Request body reads settle off-thread, and a pending guest
promise alone does not keep a process alive, so `src/native-read-retention.ts` holds the
process across them, as the WebCrypto wrappers above do: `Blob#text`, `arrayBuffer` and
`bytes` (also `File`) are replaced on the prototype with wrappers of the same name and
length; `Blob#stream` returns a byte stream whose pulls each hold the process until the
underlying native read settles (an unread stream holds nothing); and body reads hold the
process unless the body was built from a `ReadableStream`. Such a body can wait on guest
code indefinitely, which must not keep the process alive, and Chromium consumes it across
tasks, so `arrayBuffer`, `bytes`, `text`, `json` and `blob` read it in JavaScript, as Node's
undici does. Recognizing it requires the constructor argument: the Worker's `Response` and
`Request` globals are replaced by construct proxies whose instances are the browser's
(`constructor` on each prototype names the proxy). `stream/consumers` no longer holds the
process itself.

### module.findSourceMap

`module.findSourceMap(path)` returns `undefined`, `module.md`'s documented result
when no source map is found (1760-1773). It is truthful because source map
support is never enabled: nothing parses `sourceMappingURL` for guest files,
startup rejects `--enable-source-maps` with ENOSYS, and `NODE_OPTIONS` is not
interpreted, so a program that sets it there is not given maps either. The
function does not claim lookup works; `module.SourceMap`, `getSourceMapsSupport`
and `setSourceMapsSupport` remain absent. A file carrying an inline map is
compared with pinned Node, which also returns `undefined` unless the flag is set.

### util.inspect and console output of functions

`util.inspect` (`src/util-inspect.ts`) reproduces the `util` 0.12 package's
formatter, so object, array, error, date and regexp output, line breaking and
circular markers are the package's. It differs from the package in three ways,
each after Node 22. First, functions are described as Node's `getFunctionBase`
and `getClassBase` (`lib/internal/util/inspect.js`) do: `[AsyncFunction: f]`,
`[GeneratorFunction: g]`, `[AsyncGeneratorFunction: h]`, `[class B extends A]`,
`(anonymous)`, `(null prototype)`, a constructor or `Symbol.toStringTag` that
differs from the kind, then own properties, as in `[AsyncFunction: f] { flag: 1 }`.
Second, `util.inspect.custom` hooks are called with Node's `(depth, options,
inspect)`. A legacy `inspect()` method is still called first when custom
inspection is on, as the package does; Node never calls it. With
`customInspect: false` neither is called. Third, a top-level symbol prints its
description. Fourth, an own `__proto__` key prints as `['__proto__']`, as in
Node.

The kind is read from the first tokens of the function's source text, through
the `Function.prototype.toString` saved before guest code runs; that text is
what the engine's internal slots record. In experimental async context the
process also names the functions its compiler lowered. It recognizes them from
their source (through the saved built-in) and requires the async prototype the
runtime's marking gave them, so an npm package's own down-levelled `__async`
function stays an ordinary function, as in Node. `util.types.isAsyncFunction`
and `isGeneratorFunction` answer from the same kind in both modes. The guest
console (`console.log`, `error`, `warn`) formats through the runtime's
`util.format`. Proof: `tests/util-inspect-functions.spec.ts`, native-compared in
both modes.

Not covered: a Proxy's source text is native code, so a proxied function is
described like a bound one, `[Function: pa] AsyncFunction` or `[Function: PC]`,
where Node describes the target (`[AsyncFunction: pa]`, `[class PC]`) unless
`showProxy` is set (pinned). The package's own differences also remain: line
breaking, `[Circular]` without `<ref *1>`, symbol keys, `sorted`, and class
instances without their constructor name.

### Inspector (no active inspector)

`require('inspector')`, `node:inspector` and `inspector/promises` resolve to
`src/inspector.ts`. A Worker cannot serve the V8 inspector protocol, so the module
reports Node's documented inactive-inspector behavior: `url()` is `undefined`
(inspector.md, "inspector.url()", 459-470), `close()` is a no-op because no
connection can exist (408-419), `waitForDebugger()` throws
`ERR_INSPECTOR_NOT_ACTIVE`, and a never-connected `Session` rejects `post()` with
`ERR_INSPECTOR_NOT_CONNECTED`. The inactive values are compared against the pinned
native binary. `open()`, `Session#connect()` and, from a guest worker thread,
`connectToMainThread()` fail with ENOSYS, because natively they start or reach a
debugger; none claims a working one. `inspector.console` and `inspector.Network`
are not provided.

### CommonJS extension hooks and compilation

Each process exposes a shared `require.extensions` / `Module._extensions` registry
with JavaScript, JSON and explicitly unsupported native-addon handlers. Registered
suffixes participate in CommonJS file lookup; dispatch chooses the longest
registered suffix and calls its handler with the registry receiver. Unknown
explicit file suffixes fall back to JavaScript. Extensionless lookup follows the
registered keys, rather than the former hard-coded `.cjs` fallback. ESM legacy
package lookup retains its independent `.js`, `.json`, `.node` lookup rules.

`Module._compile(source, filename)` exposes the existing synchronous CommonJS
wrapper. Hooks can transform source in memory without changing canonical package
files. The wrapper preserves Node argument order, exports receiver and return
value; direct compilation does not insert the constructed module in the file
cache or mark it loaded. A constructed module must still have an assigned
filename for require/resolution. `require` delegates to the module's current
method, and `require.resolve` consults its current filename independently of the
source-label argument. Diagnostic labels are URI encoded; dynamic imports retain
the existing browser module graph and lifetime machinery.

Cached modules bypass extension handlers, cycles expose partial exports, and
failed handler execution removes the failed module's cache and parent-child
entry so a later load can retry. Native addons and synchronous require of ESM
retain explicit rejection. This does not claim arbitrary `_compile` format modes,
registry replacement, resolver monkey-patching, custom module.paths behavior,
or complete Node loader compatibility.

### process.hrtime and process.hrtime.bigint

Guest `process.hrtime`/`process.hrtime.bigint` have no syscall: each derives a
monotonic nanosecond count from `performance.timeOrigin + performance.now()` in
the process Worker. Browser engines coarsen `performance.now()` for
fingerprinting resistance, so this establishes monotonicity within a process
and agreement between the tuple and bigint forms, not native nanosecond
resolution. Invalid `time` arguments reject with the same `ERR_INVALID_ARG_TYPE`/
`ERR_OUT_OF_RANGE` codes as pinned Node; element values are not otherwise
validated, matching observed native behavior.

### Process lifecycle events

`src/process-lifecycle.ts` decides which listeners Node 22 consults and what each
outcome exits with; the bootstrap passes in the Worker, stdio and handle accounting.
The fixtures of `tests/process-exit-events.spec.ts`, `process-uncaught-exception.spec.ts`,
`process-unhandled-rejection.spec.ts` and `process-exit-children.spec.ts` run the same
files in the pinned Node 22.18.0 binary and in a process Worker, in the default runtime
and with experimental async context, and require equal exit code and stdout. The
exceptions say so in their titles: the `http` test compares response bodies, and the
`pinned:` and `browser policy:` tests assert the two sides separately.

- `exit` is emitted on drain, in `process.exit()`, and after an uncaught error that
  nothing took (code 1); the last two do not emit it a second time. The status is read
  after the listeners, so `process.exitCode` assigned inside one is honored.
  `process.exitCode` is Node's validating accessor and `process.exit(code)` assigns
  through it, so the status posted to the host is always an integer.
  `process.exit()` and a fatal error post the status and park the Worker thread until
  the host terminates it, so no reaction, `finally` or later listener runs, as in Node.
  A natural exit reports its status two host tasks later, so reactions queued by the
  listeners drain and a rejection they caused is reported; timers do not fire in that
  window and `nextTick` is dropped once `exit` has been emitted.
- `beforeExit` is emitted when the two queued checks find no referenced handle or timer.
  It is emitted again on the next drain if the listener left work: a referenced handle or
  timer after the listener or after its first reactions, a referenced timer that fired,
  or an `fs` callback or `fs/promises` operation. A process with a `beforeExit` listener
  takes one further round of checks; without one, exit timing is unchanged. It is not
  emitted for `process.exit()` or a fatal error. An unsettled top-level await emits
  `beforeExit`, then `exit` with status 13.
- Uncaught errors reach one function from four places: the Worker `error` event; a
  throw from the preloads or a CommonJS entry, raised in the same turn (origin
  `uncaughtException`); an ESM entry's rejection (origin `unhandledRejection`, as in
  Node); and a throw from a lifecycle listener the runtime itself called.
  `uncaughtExceptionMonitor` runs first, then the capture callback or
  the `uncaughtException` listeners; with neither, `exit` is emitted, the error is
  printed and the status is `process.exitCode ?? 1`. A throw from the monitor, callback
  or listener ends the process with status 7 and no `exit`.
- Rejections come from the Worker `unhandledrejection` and `rejectionhandled` events in
  both modes. In experimental mode the engine reports the scheduling promise behind a
  guest promise; it is mapped back to the guest promise, and the listener runs in the
  frame that created it. `--unhandled-rejections=throw|strict|warn|none|warn-with-error-code`
  is accepted in `execArgv` (joined or as the next argument) and read from
  `NODE_OPTIONS`; a `NODE_OPTIONS` value Node refuses (unknown mode, missing argument,
  unterminated quote, trailing escape) exits 9 with Node's message, and an invalid
  `execArgv` value is `EINVAL` at `fork`. Rejection warnings are emitted as `warning`
  and printed as `(node:<pid>) <name>: <message>` by a first `warning` listener, which
  `NODE_NO_WARNINGS=1` omits.
- A synchronous throw from an `http` `request` or `upgrade` listener, or from a request
  `data`/`end` listener, is offered to the capture callback or `uncaughtException`
  listeners through `src/uncaught-hook.ts`; the server keeps serving. With none it is
  fatal as in Node: `src/http.ts` rethrows it into the Worker `error` event, so the
  monitor and `exit` listeners run and the process exits 1. A handler that returns a
  rejected promise is an unhandled rejection and takes the rejection path.
  `tests/http-handler-throw.spec.ts` compares all of these with Node 22.18.0.

Browser policy and non-claims:

- Host `kill()`, container teardown and a default-disposition signal terminate the
  Worker abruptly. No guest `exit` or `beforeExit` listener runs.
- libuv phase ordering is still not claimed. Rejection reporting is a browser task
  queued after the microtask checkpoint, so a handler attached from a 0 ms timer can
  arrive before the report where Node would already have reported.
- Between a natural `exit` and its status report, a host message that was already
  queued (IPC, a child's port, a preview request) can still be delivered.
- The browser client of a request in flight when its guest dies from such a throw gets
  the transport's 503 (guest ended), where Node resets the connection; a preview
  WebSocket closes with 1006. Transport failures (413, 502, 503, and the 500 for a
  response over its byte budget before the head) are not guest throws and are unchanged.
- An operation the runtime completes inside the listener's own reactions other than
  `fs` (for example `dns.lookup`) is not loop work to `beforeExit`.
- Rejection ids count the rejections the engine reported, not every rejection made, so
  the id in a warning can be lower than Node's. A warning object has `name` and
  `message` only. When an `unhandledRejection` listener throws, later rejections of the
  same turn are still delivered, where Node drops them.
- The status is posted as assigned: it is not reduced modulo 256 as an OS would.
- Not implemented: `multipleResolves`, `--trace-uncaught`, and any `NODE_OPTIONS` token
  other than `--unhandled-rejections`. A fatal error prints
  its stack only, without Node's source excerpt and version trailer.

### process.emitWarning and the warning reporter

`src/process-warning.ts` ports Node 22.18's `lib/internal/process/warning.js`.
`process.emitWarning` takes all three documented forms (an `Error`, a string with
`type`/`code`/`ctor`, a string with an options object including `detail`), validates
them with Node's `ERR_INVALID_ARG_TYPE` messages, captures the stack from `ctor`
outward, and emits `warning` on `process.nextTick`. The reporter is the first
`warning` listener and prints every warning, the rejection warnings included:
`(node:<pid>) [<code>] <name>: <message>`, the `detail` line, and the
`--trace-warnings` (or, for a first deprecation, `--trace-deprecation`) hint once per
process. Startup accepts `--no-warnings`, `--no-deprecation`, `--throw-deprecation`,
`--trace-warnings` and `--trace-deprecation` in `execArgv`; the last four set
`process.noDeprecation`, `throwDeprecation`, `traceDeprecation` and
`traceProcessWarnings`, which are read live as in Node, so guest assignments take
effect. `--no-warnings` and `NODE_NO_WARNINGS=1` leave the reporter out.
`--disable-warning` and `--redirect-warnings` still fail at startup with ENOSYS.
`tests/process-emit-warning.spec.ts` compares stdout and exit status with the pinned
binary in both boots and matches stderr by pattern, because it carries the pid and
stack frames; frame locations are not compared (the CommonJS wrapper shifts lines).
Not claimed: Node runs every `nextTick` before promise reactions, while this
runtime's `nextTick` is a microtask, so a warning can be emitted after a reaction
queued later in the same turn.

### process.finalization

`src/process-finalization.ts` ports Node 22.18's `lib/internal/process/finalization.js`
onto the Worker's own `WeakRef` and `FinalizationRegistry` and the process's `exit` and
`beforeExit` events: `register` and `registerBeforeExit` validate `obj` (object or
function), install one listener per event on first use, and call
`callback(obj, event)` for objects still alive when the event is emitted;
`unregister` lets the engine validate its token (a primitive throws V8's TypeError, as
natively) and removes a listener once its event has no entries. Each method emits
Node's `ExperimentalWarning` once through `process.emitWarning`. Callbacks therefore
run wherever those events run here (natural exit, `process.exit()`, a fatal error),
and not on host `kill()` or teardown. Whether an unreachable object is collected
before exit is the engine's decision: Chromium's Worker can collect one that native
Node has not yet collected, so its callback does not run. `tests/process-finalization.spec.ts`
compares stdout and status with the pinned binary for objects kept reachable; a
collected object's skipped callback is not tested, because neither side exposes a
deterministic collection.

### Opt-in experimental async context

`BootOptions.asyncContext: 'experimental'` enables process-owned context frames,
AsyncResource/AsyncLocalStorage activation, and browser-side continuation lowering.
Default behavior is unchanged. A child compiler Worker initializes esbuild-wasm
0.28.2 and responds to bounded synchronous compilation requests, allowing the CJS
loader to retain synchronous semantics. No compiler or guest execution uses a Node
host fallback. The compiler's source bound is `modules.contextSourceBytes` and its
reply travels in a growable SharedArrayBuffer (1 MiB at start, grown on demand up to
`modules.contextOutputBytes`); neither is a fixed structural limit. CJS, ESM function bodies, _compile, VM expressions, Function, and
selected eval forms route through this compiler; original filesystem bytes remain
unchanged. Source maps and the existing ESM publication budget constrain compiled
artifacts. After compilation `src/context-lowered.ts` parses the output and inserts
calls that give each lowered async function (and async generator) the engine's
`AsyncFunction.prototype` as it is created, so its constructor is the runtime's
compiling constructor; stack positions are mapped back through the insertions. See experimental context for evidence
and limits, including unsupported Promise subclasses, full scheduling fidelity, and
incomplete reflective/dynamic-code graph coverage. `async_hooks.createHook` fires
for the resources the runtime itself tracks (timers, ticks, microtasks, guest
promises, AsyncResource); it is not engine instrumentation and announces no native
handle types. ESM module bodies
cannot be wrapped, so the runtime rewrites top-level awaits to capture and re-enter
the awaiting frame, and `import()` carries the importer's frame into the graph's
evaluation job; the browser engine still owns linking and evaluation order.

### Preview HTTP transport

One preview request is one `MessageChannel`. The service worker (`src/preview-fetch.ts`)
posts an `http` message carrying method, URL, headers and `bodyLength` to the owning
host page with one port; the host (`src/preview-relay.ts`) resolves the port owner and
posts the same head to the guest Worker with a second port; the guest
(`dispatch` in `src/http.ts`) builds the `IncomingMessage` and `ServerResponse` on it.
From then on both directions carry the frames defined in `src/preview-stream.ts`, each
tagged with the protocol version:

| Frame    | Direction       | Meaning                                                                              |
| -------- | --------------- | ------------------------------------------------------------------------------------ |
| `head`   | guest → browser | Status and headers, posted when the guest first flushes them.                        |
| `data`   | both            | At most one 64 KiB transport chunk of body; guest and upload chunks are transferred. |
| `credit` | both            | The receiver handed that many `data` bytes to its consumer.                          |
| `end`    | both            | The body is complete.                                                                |
| `abort`  | both            | The exchange is over early; carries an error record when there is a cause.           |
| `ping`   | browser → host  | The service worker's reader still exists.                                            |

- Response streaming. `ServerResponse` posts `head` on the first of `flushHeaders()`,
  `write()` or `end()`, and each `write()` as `data` frames. The service worker resolves
  `respondWith` on `head` with a `Response` over a `ReadableStream`, so the page reads
  chunk one before the guest ends the response. The stream has no queue of its own
  (`highWaterMark: 0`).
- Request streaming. The service worker forwards `request.body` as it is read and the
  guest pushes each frame into the `IncomingMessage`. Chromium hands a body it already
  holds in memory (bytes, text, URL-encoded forms) to the fetch event as a single chunk;
  it is still sent to the guest in 64 KiB frames under the same window. Such a body's
  length is known before dispatch, so the guest sees `Content-Length`; a
  `ReadableStream`, `Blob` or file-backed form body is dispatched at once and the guest
  sees `Transfer-Encoding: chunked`.
- Flow control. A sender may have at most one window of `data` bytes outstanding per
  direction: `preview.responseWindowBytes` and `preview.requestWindowBytes`, 1 MiB each
  by default. A frame stays outstanding until the receiver's consumer takes it - the
  browser's reader for a response, the guest's `Readable` for a request - and the
  receiver answers with `credit`. `ServerResponse._write` completes only when its
  chunk is inside the window, so a page that stops reading makes `res.write` return
  `false` and `drain` fire when it reads again. The same rule stops the service worker
  reading the browser's upload when the guest stops reading.
- In-flight bound. Per response: one window between guest and browser reader, held in
  the service worker; the host relay buffers nothing. Per request: one window, held in
  the guest's frame queue, plus the one chunk the service worker last read from the
  browser (its size is the browser's choice). The guest's own stream buffers sit
  outside the window: the `Readable` holds up to one further frame, and the `Writable`
  holds what the guest wrote after `write` returned `false`, bounded by
  `preview.responseBytes` because bytes are counted when accepted. The host relay and
  both ends meter every frame and end the exchange on the first one beyond the window
  or the total. `BrowserContainer.previewStreams()` reports open exchanges and the peak
  outstanding bytes per direction.
- Budgets. `preview.requestBodyBytes` and `preview.responseBytes` are totals, default
  1 MiB and 64 MiB, raisable to any safe integer or to `Infinity` (`UNBOUNDED`). An
  in-memory request over budget is refused with 413 before dispatch, as before. A
  response over budget before its head is a 500 carrying the `E2BIG` message, as
  before; after the head the status is already delivered, so the body stream errors.
  A streamed request over budget before the response head is a 413 and the guest sees
  the request aborted. Overflows after dispatch reach the host as a `LimitError`
  (`E2BIG`, with `limit` and `actual`) in `previewStreams().lastFailure`.
- Cancellation. A reader cancel, `AbortController` abort or navigation cancels the
  service worker's stream, which sends `abort`; the guest emits `aborted` on the request
  and `close` on the response in the same turn, then `close` (and `error`, if listened
  for) on the request, matching pinned Node 22. `res.write` afterwards returns `false`
  and reports `ERR_STREAM_DESTROYED` to its callback only. A guest that exits or is
  killed, or a container teardown, makes the host relay answer 503 if no head was sent
  and otherwise error the body stream.
- Liveness. The relay waits `timers.previewHostRequestMs` and the service worker
  `timers.previewGuestRequestMs` for a head; request-body progress restarts both. After
  the head there is no deadline on a body. The service worker polls for its owner page
  and pings the host; the host ends an exchange after `timers.previewStreamIdleMs`
  without a frame or ping, which is how a stopped service worker is noticed.
- Framing headers. The guest chooses `Content-Length` for a response ended in one call
  and `Transfer-Encoding: chunked` for one written before its end, neither for HEAD, 204
  or 304, and the service worker passes them to the `Response`. `Connection` is dropped.
  The service worker offers the guest `Accept-Encoding: gzip, deflate` and decodes such a
  body itself, dropping `Content-Encoding` and `Content-Length` (see "Compression" under
  [Per-origin preview](#per-origin-preview-opt-in-milestone-1)); other encodings pass through.
- Redirect `Location`. In prefix mode a root-relative `Location` would send the browser
  to the host's own path. `previewFetch` therefore passes every response head through
  `rewritePreviewLocation` (`src/preview-location.ts`, pure, unit-tested), the one place
  a guest head becomes a browser `Response`; it covers streamed and buffered replies and
  both `requestPath` modes, and the relay and guest are unchanged. It applies to any
  status that carries exactly one `Location` (3xx, 201). A value with a single leading
  `/` becomes `/__preview__/<container>/<port>/...` with query and fragment kept. A value
  already at the prefix is not rewritten again, which is what keeps a `preserve`-mode app
  that builds its own base from being double-prefixed; a root-relative value without the
  prefix is rewritten in `preserve` mode too, because it could only reach the host's own
  path. Protocol-relative (`//h`, `/\h`), absolute (including `http://127.0.0.1:<port>`;
  the runtime tells the guest no `Host`, so there is no authority to match), relative,
  query-only, fragment-only, repeated, non-string and control-character values pass
  through unchanged. `Set-Cookie` is not touched and WebSocket upgrades are unchanged.
  The browser follows 301/302/303/307/308 itself: `fetch` with `redirect: 'manual'`
  exposes an opaque redirect (status 0, no headers), and a 201 `Location` is a plain
  header the page can read.
- Preview WebSocket injection is streamed too. `src/preview-inject.ts` holds only the
  leading bytes that can still precede a `<head>` tag (whitespace, doctype, comments,
  `<html>`), at most 64 KiB, inserts the bridge script after the head tag, and
  otherwise falls back to after the doctype or the start. A document whose head tag
  follows other content is no longer searched whole. `Content-Length` is dropped from
  an injected response.

Not claimed: this is not a TCP stack, there is no socket, keep-alive, pipelining,
trailer or `101`/`1xx` support, and `Date`/`Connection`/`Keep-Alive` headers are not
synthesized. Chromium buffers a `Response` stream between the service worker and the
page beyond these windows (tens of MiB were observed before `pull` stopped), so the
window bounds this runtime's realms, not the browser's. A streamed response lives only
as long as the browser keeps the service worker running. The message protocol version
is 4; a host page and a service worker of different versions fail registration with
`EPROTO`, and a service worker never activates over live clients.

### Per-origin preview (opt-in, milestone 1)

Design (a) of preview routing, milestone 1. With
`boot({ preview: { origin: 'https://{container}-{port}.preview.example.com' } })`,
`preview(port)` returns `<that origin>/` instead of a `/__preview__/<id>/<port>/` URL, so the
app's root-relative URLs resolve inside its own origin. Without the option every prefix-mode path,
header and URL is unchanged.

- Template. `parsePreviewOptions` (`src/preview-origin.ts`, pure, unit-tested) runs at boot before
  any Worker or registration: `TypeError`/`ERR_INVALID_ARG_TYPE` for a bad shape or unknown key;
  `EINVAL` for a missing placeholder, a value that is not an http(s) origin (path, query, fragment,
  credentials), the host's own origin, an origin that is neither https nor localhost/`*.localhost`
  /loopback (a service worker needs a secure context), or placeholders that do not give each
  container and port its own origin. `embedderPolicy` accepts only `'require-corp'` (decision 6).
- Bridge. `preview(port)` inserts one hidden iframe at `<origin>/__inbrowser__/bridge.html?host=<host
origin>` (`src/preview-bridge.ts`). The bridge (`src/preview-bridge-frame.ts`, inlined at build)
  registers `/__inbrowser_preview_sw.js` at scope `/`, waits for control and posts `need-port` to
  its parent at the named host origin only. The host accepts it only from that iframe's window and
  origin, and transfers one end of a `MessageChannel` bound to this container and port; the bridge
  forwards it to its worker, which answers `ready` on it. `preview()` resolves then, within
  `timers.previewLookupMs` (shared with the listener lookup). Messages carry a bridge version (1)
  and the frame protocol `VERSION`; a mismatch rejects with `EPROTO`.
- Worker (`src/preview-origin-sw.ts`, built to `dist/preview-origin/`). Every same-origin request
  except the bridge and worker paths goes to `previewFetch` with `send` posting on the bridge port:
  the same `http` head, frames, windows, budgets and deadlines as prefix mode. The host routes it
  into `forwardHttp` and `PreviewRelays` after checking the container and port match the binding.
  `mode: 'origin'` makes `previewFetch` skip the `Location` rewrite and send
  `Cross-Origin-Resource-Policy: cross-origin` with `Cross-Origin-Embedder-Policy: require-corp`.
  Liveness is a round trip on the bridge port, failing after `timers.previewStreamIdleMs`.
- Recovery. A stopped worker loses its port. The next request finds the bridge among the origin's
  window clients, asks it for a new port and waits `timers.previewDiscoverMs` (default policy,
  since a restarted worker has none); the host reissues, at most 256 times per bridge. With no
  bridge client it answers 503.
- Teardown tells the worker the host is gone (later requests get 503), asks the bridge to
  unregister its worker (bounded to 1 s) and removes the iframe.
- Options. `requestPath: 'preserve'` is `EINVAL` in origin mode. `webSocket` defaults to true
  (milestone 2, below).
- Embedder files: `dist/preview-origin/__inbrowser_preview_sw.js`,
  `__inbrowser__/bridge.html`, and `__inbrowser__/unavailable.html` served with 503 for every
  other path; all with COEP `require-corp`, CORP `cross-origin`, `Cache-Control: no-store`.
  `scripts/serve.mjs` serves them on `PREVIEW_PORT` (default `PORT + 2000`) for any
  `*.localhost` host.

Milestone 2 (2026-10-05):

- Cookies (decision 4). `src/preview-cookies.ts` (pure, unit-tested) is an RFC 6265 jar with the
  6265bis bounds: nameless cookies, control characters, 4096-byte pairs, 1024-byte attributes,
  `Max-Age` over `Expires` and the cookie-date algorithm; `Domain` accepted only when the preview
  host domain-matches it and kept host-only (one jar serves one origin; no public-suffix list);
  `Secure` only from a potentially trustworthy origin (https, `localhost`, `*.localhost`,
  loopback, as Chromium treats them); `__Secure-`/`__Host-`; `SameSite=None` requires `Secure`;
  no `SameSite` is Lax; at most 180 cookies, least recently used evicted. Each `Bridge`
  (`src/preview-bridge.ts`) owns one jar, so it lives in the host page for exactly one container
  and preview origin, outlives a stopped preview worker, is not persisted, and never puts an
  `HttpOnly` value in a realm on the preview origin. The bridge adds the jar's `Cookie` to each
  `http` message and moves `Set-Cookie` out of the guest's head through a relay head hook
  (`PreviewHeadHook`, `src/preview-relay.ts`); the head frame then carries the script-visible
  changes as mirror operations (`cookies`, validated in `src/preview-stream.ts`). The preview
  worker replays them with `cookieStore.set`/`delete` before it resolves the response, reads
  page-script cookies with `cookieStore.getAll()` for each request and filters them by path and
  SameSite as the jar filters its own (`pageCookieHeader`; for a name the jar holds, the jar
  wins; at most 8 KiB), and reports each request's SameSite context. Chromium 145 answers a
  worker's `getAll()` for its scope URL `/` and refuses a `url` option naming a request path, so
  a page cookie with a Path narrower than `/` never reaches the guest. A navigation counts as
  cross-site when its referrer's origin is not the preview origin, or it has none: Chromium's
  `clientId` on a navigation names the navigated frame's current document, not the initiator.
  This is cross-origin, not cross-site: in a same-site deployment a navigation from the host page
  or a sibling preview drops `Strict` cookies a browser would send.
  Cross-site navigations get `None` cookies, and `Lax` ones on safe methods (the preview stands
  in for a top-level app, also when a cross-site host page frames it); subresource requests reach
  the worker only from its own clients. The
  mirror runs only when the bridge document, framed like the preview, can write and read
  `document.cookie`, which it probes at startup and reports with `need-port`; in a cross-site
  topology it cannot (Chromium let the worker's `cookieStore.set` succeed, but the framed
  document saw no cookies). Teardown deletes the mirrored cookies the bridge can see (not covered by a test).
  Tested: no message into the preview worker's realm carries an `HttpOnly` value or a
  `set-cookie` header (recorded inside the worker); a guest `Domain=<parent>` cookie reaches
  neither a sibling preview nor the host page in the same-site topology. Differences from a
  browser are listed in [limits](../guide/limits.md).
- WebSocket bridge (decision 5), on unless `preview(port, { webSocket: false })`. The socket
  client is `src/preview-socket-client.ts`; `src/preview-socket.ts` (prefix, unchanged claims and
  message) and `src/preview-origin-socket.ts` (every socket to the page's own host) only route.
  The origin bundle is embedded in the preview worker at build time and served at
  `/__inbrowser__/preview-socket.js`, so the embedder contract stays three files. The worker
  injects it into HTML navigations only (prefix mode injects into every 200 `text/html`), and
  forwards each `socket` message on its bridge port with its binding; the bridge checks the
  binding and `forwardSocket` checks the page origin against the preview origin. Both are tested
  through a stolen bridge port: another binding, or the own binding with a forged page origin,
  gets `error`, and the own binding with the preview origin opens.
- Compression, both modes. A fetch event does not show the `Accept-Encoding` of `fetch()` and navigation requests (media elements' requests carry theirs), and
  Chromium 145 does not decode a worker-built `Response` by its `Content-Encoding` (the page
  read the compressed bytes). `previewFetch` therefore offers the guest `Accept-Encoding: gzip,
deflate` and decodes `gzip`/`x-gzip`/`deflate` bodies with `DecompressionStream`, dropping
  `Content-Encoding` and `Content-Length`, before any socket injection. Other or stacked
  encodings pass through as sent. A `Range` request or an `Accept: text/event-stream` (`EventSource`) request gets the request's own `Accept-Encoding` when the event carries one (media
  elements or explicit `fetch` header) and `identity` otherwise, so byte-range slices arrive uncompressed and compression middleware does not buffer SSE frames. Only zlib-wrapped `deflate` decodes (a raw deflate body fails); see
  [limits](../guide/limits.md).

Covered by `tests/preview-origin.spec.ts`, `tests/preview-origin-partitioned.spec.ts` (which
re-enables `ThirdPartyStoragePartitioning`; Playwright disables it),
`tests/preview-origin-cookies.spec.ts` (including a same-site topology, host `host.localhost`
and previews `<id>-<port>.host.localhost`), `tests/preview-origin-websocket.spec.ts`,
`tests/preview-origin-eventsource.spec.ts`,
`tests/preview-origin-vite.spec.ts`, `tests/preview-origin-security.spec.ts`,
`tests/preview-compression.spec.ts` and next-ssr-origin.
Not implemented: cookie persistence, Astro dev, local HTTPS. In a cross-site deployment a
preview opened in a new top-level tab is in another storage partition and is not served
(observed with partitioning on). Only Chromium was run.

### Resource policy

`src/resource-policy.ts` names every bounded value the runtime enforces - 81 byte
caps, counts and deadlines - in one interface grouped by area, with
`DEFAULT_RESOURCE_POLICY` holding exactly the constants the code already used, so
default behavior is unchanged. `BootOptions.resources` takes a deep partial;
`resolveResourcePolicy` merges and validates it before any Worker or
service-worker registration exists, rejecting a bad shape or unknown name with
`TypeError`/`ERR_INVALID_ARG_TYPE` and a non-positive, non-integer or
over-maximum value with `RangeError`/`ERR_OUT_OF_RANGE`, matching Node argument
validation rather than the runtime taxonomy. The resolved policy rides the
existing messages - the kernel `ready` handshake, each process Worker's `boot`,
the service worker's `register` and `discover` - and each realm installs it
before guest code runs, so an enforcement site reads its bound instead of a local
constant. The service worker keeps a policy per container in its owner record.
Structural constants stay constants: the 1 MiB syscall slot and 16-byte header
(both peers map the same `SharedArrayBuffer`), the 64 KiB transport chunk (kernel
pipe pages are allocated at that size), the protocol version, the compiler
Worker's buffer sizes and the preview-socket bounds (that realm receives no boot
message). `httpResponseLimit`, `unzipLimit` and `descriptorReadLimit` remain as
deprecated aliases with their original `EINVAL` validation.
[docs/reference/resource-policy.md](resource-policy.md) carries the full table, both
configurable and fixed.

### Host error taxonomy

`src/errors.ts` classifies the runtime's own failures: `RuntimeError` carries `code`
and a `kind`, and `UnsupportedError`/`LimitError`/`ChannelError`/`LifecycleError` fix
the four kinds (`unsupported`, `limit`, `channel`, `lifecycle`). A single code-to-kind
map in that file drives `fault()`, so the ~146 `ENOSYS` and 35 files of `E2BIG` sites
gain a class without changing a call site: `ENOSYS`/`ENOTSUP` are unsupported,
`E2BIG`/`ENOMEM`/`EOVERFLOW` are limits, `ETIMEDOUT`/`EPROTO` are channel failures,
and `EPIPE`/`ESRCH`/`EASSET` are lifecycle failures. `EPIPE` is nearly always a closed
container, process or stream, so the one poisoned-channel site passes `kind: 'channel'`
explicitly; a few limit sites also pass numeric `limit`/`actual` bounds. The taxonomy is
additive: codes outside the map, including the guest-visible Node codes (`EINVAL`,
`ENOENT`, `ERR_INVALID_ARG_TYPE`, `Z_DATA_ERROR`, `ABORT_ERR`), still produce plain coded
`Error` objects, and no subclass overrides `name`, because guest programs print these
errors and asserted output depends on the Node `Error: <message>` shape. `errorRecord`
adds `kind` and present bounds to the syscall/RPC record only when they exist, and
`reviveError` reconstructs the subclass on the receiving side, so a kernel-side limit
rejects a host promise with a real `LimitError`; a record without `kind` (an older peer)
revives as a plain `Error`, as before.
