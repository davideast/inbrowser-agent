import { DEFAULT_DESCRIPTOR_READ_LIMIT } from './descriptor-read-limit';
import { HTTP_LIMIT, HTTP_RESPONSE_LIMIT } from './http-limits';
import { DEFAULT_HTTP_RESPONSE_LIMIT } from './http-response-limit';
import { MODULE_SOURCE_LIMIT, MODULE_TOTAL_LIMIT } from './module-limits';
import { CALL_TIMEOUT, CAPACITY, HEADER_BYTES, fault, record } from './protocol';
import { SNAPSHOT_BYTES, SNAPSHOT_ENTRIES } from './snapshot';
import { DEFAULT_UNZIP_LIMIT } from './unzip-limit';

// One place to see, configure and validate every bounded value the runtime
// enforces. The defaults below are exactly the constants the code shipped with,
// so a container booted without `resources` behaves byte-identically; the policy
// is resolved once on the host and handed to the kernel Worker, every process
// Worker and the service worker, which read their bounds from it.
//
// Structural constants are deliberately absent from `ResourcePolicy`: Workers
// size SharedArrayBuffers from them at boot, or two peers must agree on them
// before either can validate a message. They stay constants in their own
// modules and are named in `FIXED_LIMITS` for discoverability only.
// docs/reference/resource-policy.md carries the full table, configurable and fixed.

/** Syscall transport deadlines. The 1 MiB slot and 16-byte header are fixed. */
export interface SyscallPolicy {
  /** Guest wait for one kernel syscall completion before the channel poisons. */
  callTimeoutMs: number;
  /** Host wait for one kernel RPC reply. */
  kernelRequestTimeoutMs: number;
}

export interface FilesystemPolicy {
  /** Maximum bytes requested per descriptor read. */
  descriptorReadBytes: number;
  /** Maximum bytes accepted per descriptor write. */
  descriptorWriteBytes: number;
  /** Maximum bytes for a whole-file read. */
  fileReadBytes: number;
  /** Largest accepted `createReadStream` highWaterMark. */
  readStreamHighWaterMarkBytes: number;
  /** Aggregate regular-file and symbolic-link payload bytes in the volume. */
  maxTotalBytes: number;
  /** Live inodes (files, directories and symbolic links) in the volume. */
  maxInodes: number;
  /** Open file descriptors in the kernel volume table across the container. */
  maxOpenDescriptors: number;
  /** Registered watchers per guest process. */
  processWatchers: number;
  /** Host-side watch subscriptions per container. */
  hostWatchers: number;
  /** Undelivered events queued per host watch subscription. */
  watchQueueEvents: number;
  /** Queued filename bytes per host watch subscription. */
  watchQueueBytes: number;
}

export interface ModulesPolicy {
  /** Bytes per published module source, and per `vm` compilation unit. */
  sourceBytes: number;
  /** Aggregate published module bytes per process. */
  graphBytes: number;
  /** Published module URLs per process. */
  countPerProcess: number;
  /**
   * Source-map text retained per process so experimental async context can
   * report original stack positions. A script past the bound keeps the
   * positions of its compiled form.
   */
  contextSourceMapBytes: number;
  /**
   * Source bytes the experimental async-context compiler accepts per
   * compilation, checked before and after the loader's own rewriting.
   */
  contextSourceBytes: number;
  /**
   * Compiled bytes (code plus inline source map) the compiler may reply with.
   * The reply buffer is growable up to this bound plus an 8-byte header and is
   * committed only as replies need it.
   */
  contextOutputBytes: number;
}

export interface HttpPolicy {
  /** Decoded response bytes buffered per outbound Fetch response. */
  responseBytes: number;
  /** Serialized request or response header bytes per outbound request. */
  headerBytes: number;
  /** Outbound request body bytes in Fetch mode, and request/response body bytes in socket mode. */
  clientBodyBytes: number;
  /** Active plus queued requests per `Agent` instance. */
  agentRequests: number;
}

export interface PreviewPolicy {
  /** Total request body bytes one preview request may stream; `UNBOUNDED` lifts it. */
  requestBodyBytes: number;
  /** Total response body bytes one preview response may stream; `UNBOUNDED` lifts it. */
  responseBytes: number;
  /** Request body bytes in flight between the service worker and the guest reader. */
  requestWindowBytes: number;
  /** Response body bytes in flight between the guest and the browser's stream reader. */
  responseWindowBytes: number;
  /** Module source bytes the service worker will serve. */
  moduleSourceBytes: number;
  /** Live WebSocket relays per container. */
  relaysPerContainer: number;
}

export interface ChildPolicy {
  /** Concurrent live guest processes and worker threads per container. */
  maxProcesses: number;
  /** Child output the parent retains in a piped stdout or stderr, in aggregate; inherited output does not count. */
  outputBytes: number;
  /** Undelivered child stdin bytes queued in the host. */
  inputQueueBytes: number;
  /** Undelivered child stdin writes queued in the host. */
  inputQueueDeliveries: number;
  /** Largest accepted `ContainerProcess.stdin` chunk. */
  stdinChunkBytes: number;
  /** Unread bytes buffered per kernel stdin pipe. */
  pipeBytes: number;
  /** Concurrent unsatisfied guest stdin reads. */
  pendingStdinReads: number;
  /** Buffered terminal input bytes per device. */
  terminalInputBytes: number;
  /** Longest accepted single terminal input line in the kernel discipline. */
  terminalLineBytes: number;
  /** Longest accepted single `readline` input line. */
  readlineLineBytes: number;
  /**
   * Most recent bytes a host process handle retains per stream for
   * `stdout`/`stderr`/`stdoutText`/`stderrText`; older bytes are dropped and counted.
   */
  captureBytes: number;
  /** Buffered bytes per host output-stream observer before it errors. */
  outputObserverBytes: number;
  /** Words produced by one shell command line. */
  shellWords: number;
  /** Bytes in one shell command line. */
  shellScriptBytes: number;
  /** Startup (`execArgv`) strings per process. */
  execArgvCount: number;
  /** Aggregate startup (`execArgv`) bytes per process. */
  execArgvBytes: number;
  /** Bytes per `randomBytes`/`randomFill` allocation. */
  randomAllocationBytes: number;
  /** Bytes per `timingSafeEqual` operand. */
  comparisonBytes: number;
  /** Bytes per IPC message. */
  ipcMessageBytes: number;
  /** Unacknowledged IPC messages per direction. */
  ipcQueuedMessages: number;
  /** Unacknowledged IPC bytes per direction. */
  ipcQueuedBytes: number;
  /** Nodes in one advanced-serialization IPC graph. */
  ipcGraphNodes: number;
  /** Edges in one advanced-serialization IPC graph. */
  ipcGraphEdges: number;
  /** Depth of one advanced-serialization IPC graph. */
  ipcGraphDepth: number;
  /** Aggregate array slots in one advanced-serialization IPC graph. */
  ipcArraySlots: number;
  /** Bytes per worker-thread message. */
  threadMessageBytes: number;
  /** Unacknowledged worker-thread messages per direction. */
  threadQueuedMessages: number;
  /** Unacknowledged worker-thread bytes per direction. */
  threadQueuedBytes: number;
  /** Bytes per transferred worker-thread ArrayBuffer. */
  threadTransferBytes: number;
  /** Entries in one worker-thread `Map` or `Set`. */
  threadCollectionEntries: number;
  /** Nodes in one worker-thread structured-clone graph. */
  threadGraphNodes: number;
  /** Edges in one worker-thread structured-clone graph. */
  threadGraphEdges: number;
  /** Depth of one worker-thread structured-clone graph. */
  threadGraphDepth: number;
}

export interface SnapshotPolicy {
  /** Logical filesystem bytes per snapshot or checkpoint. */
  bytes: number;
  /** Entries per snapshot or checkpoint. */
  entries: number;
  /** Logical bytes per persisted package cache. */
  packageCacheBytes: number;
  /** Files per persisted package cache. */
  packageCacheFiles: number;
  /** Serialized checkpoint startup-configuration bytes. */
  startupConfigBytes: number;
}

export interface InstallPolicy {
  /** Aggregate staged bytes for one install. */
  packageBytes: number;
  /** Bytes per downloaded package archive. */
  archiveBytes: number;
  /** Input and output bytes per gzip/gunzip operation. */
  gzipBytes: number;
  /** Input and output bytes per `Unzip` decoder. */
  unzipBytes: number;
  /** Locked package entries installed in one call. */
  lockedPackages: number;
}

/** Every deadline that bounds a pending operation, in milliseconds. */
export interface TimersPolicy {
  /** Grace period between delivering SIGINT and terminating the Worker. */
  interruptGraceMs: number;
  /** One gzip/gunzip operation. */
  gzipMs: number;
  /** IndexedDB open and transaction deadline. */
  storeMs: number;
  /** One package download or archive stream. */
  downloadMs: number;
  /** One experimental browser compilation. */
  contextCompilerMs: number;
  /** One outbound browser HTTP request. */
  httpRequestMs: number;
  /** Guest crypto WASM initialization. */
  cryptoInitMs: number;
  /** Host wait for a guest to listen on the previewed port. */
  previewLookupMs: number;
  /** Host wait for a guest reply to one forwarded preview request. */
  previewHostRequestMs: number;
  /** Service-worker wait for a guest reply to one preview request. */
  previewGuestRequestMs: number;
  /** Service-worker wait for a published module source. */
  previewModuleRequestMs: number;
  /** Service-worker wait for one client to claim a container after a restart. */
  previewDiscoverMs: number;
  /** Host wait for a service-worker registration step or handshake. */
  serviceTaskMs: number;
  /** Idle period after which a host preview WebSocket relay is closed. */
  previewSocketIdleMs: number;
  /** Service-worker silence after which the host closes a streamed preview exchange. */
  previewStreamIdleMs: number;
}

/** Every configurable bound the runtime enforces, grouped by area. */
export interface ResourcePolicy {
  syscall: SyscallPolicy;
  filesystem: FilesystemPolicy;
  modules: ModulesPolicy;
  http: HttpPolicy;
  preview: PreviewPolicy;
  child: ChildPolicy;
  snapshot: SnapshotPolicy;
  install: InstallPolicy;
  timers: TimersPolicy;
}

/**
 * Keys that were removed from the policy. An override may still name one: it is
 * validated as before and then ignored, because the bound it set no longer
 * exists, so a boot configuration written for an older runtime keeps working.
 */
export const REMOVED_LIMITS: {
  readonly [Group in keyof ResourcePolicy]?: ReadonlyArray<string>;
} = Object.freeze({
  // Peer acknowledgement deadline. Removed: no channel times out a busy peer.
  timers: Object.freeze(['channelAckMs'] as const),
});

/** Deep-partial overrides: any subset of groups, any subset of their keys. */
export type ResourcePolicyOverrides = {
  [Group in keyof ResourcePolicy]?: Partial<ResourcePolicy[Group]> &
    (Group extends 'timers'
      ? {
          /** @deprecated Removed; accepted for compatibility and ignored. */
          channelAckMs?: number;
        }
      : unknown);
};

const MiB = 1024 * 1024;

export const DEFAULT_RESOURCE_POLICY: ResourcePolicy = Object.freeze({
  syscall: Object.freeze({
    callTimeoutMs: CALL_TIMEOUT,
    kernelRequestTimeoutMs: 7000,
  }),
  filesystem: Object.freeze({
    descriptorReadBytes: DEFAULT_DESCRIPTOR_READ_LIMIT,
    descriptorWriteBytes: 32 * MiB,
    fileReadBytes: 32 * MiB,
    readStreamHighWaterMarkBytes: 1 * MiB,
    maxTotalBytes: 1024 * MiB,
    maxInodes: 200000,
    maxOpenDescriptors: 4096,
    processWatchers: 4096,
    hostWatchers: 4096,
    watchQueueEvents: 256,
    watchQueueBytes: 1 * MiB,
  }),
  modules: Object.freeze({
    sourceBytes: MODULE_SOURCE_LIMIT,
    graphBytes: MODULE_TOTAL_LIMIT,
    countPerProcess: 2048,
    contextSourceMapBytes: 32 * MiB,
    contextSourceBytes: 32 * MiB,
    // Four times the source bound, the ratio the fixed 8 MiB and 32 MiB had.
    contextOutputBytes: 128 * MiB,
  }),
  http: Object.freeze({
    responseBytes: DEFAULT_HTTP_RESPONSE_LIMIT,
    headerBytes: 65536,
    clientBodyBytes: 8 * MiB,
    agentRequests: 1024,
  }),
  preview: Object.freeze({
    requestBodyBytes: HTTP_LIMIT,
    responseBytes: HTTP_RESPONSE_LIMIT,
    requestWindowBytes: 1 * MiB,
    responseWindowBytes: 1 * MiB,
    moduleSourceBytes: MODULE_SOURCE_LIMIT,
    relaysPerContainer: 64,
  }),
  child: Object.freeze({
    maxProcesses: 64,
    outputBytes: 32 * MiB,
    inputQueueBytes: 32 * MiB,
    inputQueueDeliveries: 1024,
    stdinChunkBytes: 32 * MiB,
    pipeBytes: 32 * MiB,
    pendingStdinReads: 1024,
    terminalInputBytes: 32 * MiB,
    terminalLineBytes: 65536,
    readlineLineBytes: 65536,
    captureBytes: 16 * MiB,
    outputObserverBytes: 1 * MiB,
    shellWords: 2048,
    shellScriptBytes: 65536,
    execArgvCount: 256,
    execArgvBytes: 65536,
    randomAllocationBytes: 32 * MiB,
    comparisonBytes: 32 * MiB,
    ipcMessageBytes: 1 * MiB,
    ipcQueuedMessages: 64,
    ipcQueuedBytes: 8 * MiB,
    ipcGraphNodes: 4096,
    ipcGraphEdges: 65536,
    ipcGraphDepth: 128,
    ipcArraySlots: 1 * MiB,
    threadMessageBytes: 1 * MiB,
    threadQueuedMessages: 64,
    threadQueuedBytes: 8 * MiB,
    threadTransferBytes: 32 * MiB,
    threadCollectionEntries: 65536,
    threadGraphNodes: 4096,
    threadGraphEdges: 65536,
    threadGraphDepth: 128,
  }),
  snapshot: Object.freeze({
    bytes: SNAPSHOT_BYTES,
    entries: SNAPSHOT_ENTRIES,
    packageCacheBytes: 128 * MiB,
    packageCacheFiles: 100000,
    startupConfigBytes: 65536,
  }),
  install: Object.freeze({
    packageBytes: 256 * MiB,
    archiveBytes: 64 * MiB,
    gzipBytes: 32 * MiB,
    unzipBytes: DEFAULT_UNZIP_LIMIT,
    lockedPackages: 2048,
  }),
  timers: Object.freeze({
    interruptGraceMs: 250,
    gzipMs: 7000,
    storeMs: 7000,
    downloadMs: 20000,
    contextCompilerMs: 20000,
    httpRequestMs: 20000,
    cryptoInitMs: 5000,
    previewLookupMs: 30000,
    previewHostRequestMs: 120000,
    // Must stay longer than previewHostRequestMs: the host's 503 reaches the
    // browser only if the service worker is still waiting when it fires.
    previewGuestRequestMs: 125000,
    previewModuleRequestMs: 5000,
    previewDiscoverMs: 500,
    serviceTaskMs: 5000,
    previewSocketIdleMs: 15000,
    previewStreamIdleMs: 15000,
  }),
});

/**
 * Structural bounds that stay constants. A Worker sizes a buffer from them at
 * boot, or both peers must agree on them before either can validate a message,
 * so an override could only produce a protocol mismatch. Named here so one file
 * still accounts for every bounded value; see docs/reference/resource-policy.md.
 */
export const FIXED_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  syscallPayloadBytes: CAPACITY,
  syscallHeaderBytes: HEADER_BYTES,
  transportChunkBytes: 65536,
  previewSocketBytes: 1 * MiB,
  previewSocketQueuedPackets: 1024,
  previewSocketFragments: 1024,
});

/** Hard maxima the runtime already enforced before the policy existed. */
export const RESOURCE_POLICY_MAXIMA: {
  readonly [Group in keyof ResourcePolicy]: Readonly<
    Partial<Record<keyof ResourcePolicy[Group], number>>
  >;
} = Object.freeze({
  syscall: Object.freeze({}),
  filesystem: Object.freeze({ descriptorReadBytes: 64 * MiB }),
  // The reply length travels in a signed 32-bit header word, and the buffer
  // reserves its maximum as address space up front.
  modules: Object.freeze({ contextSourceBytes: 256 * MiB, contextOutputBytes: 1024 * MiB }),
  http: Object.freeze({ responseBytes: 64 * MiB }),
  preview: Object.freeze({}),
  child: Object.freeze({}),
  snapshot: Object.freeze({}),
  install: Object.freeze({ unzipBytes: 256 * MiB }),
  timers: Object.freeze({}),
});

/**
 * The value that marks a total budget as unbounded. Only the limits named in
 * `UNBOUNDED_LIMITS` accept it: they are totals over a streamed body whose
 * memory is bounded separately by an in-flight window, so lifting the total
 * does not lift any buffer. Every other limit sizes a buffer or a queue.
 */
export const UNBOUNDED = Number.POSITIVE_INFINITY;

export const UNBOUNDED_LIMITS: {
  readonly [Group in keyof ResourcePolicy]?: ReadonlyArray<keyof ResourcePolicy[Group]>;
} = Object.freeze({
  preview: Object.freeze(['requestBodyBytes', 'responseBytes'] as const),
});

function removedLimit(group: string, key: string): boolean {
  const keys: ReadonlyArray<string> | undefined = (
    REMOVED_LIMITS as Record<string, ReadonlyArray<string> | undefined>
  )[group];
  return keys !== undefined && keys.includes(key);
}

function unboundable(group: string, key: string): boolean {
  const keys: ReadonlyArray<string> | undefined = (
    UNBOUNDED_LIMITS as Record<string, ReadonlyArray<string> | undefined>
  )[group];
  return keys !== undefined && keys.includes(key);
}

/** The three deprecated `BootOptions` aliases, already range-validated. */
export interface ResourcePolicyAliases {
  httpResponseLimit?: number;
  unzipLimit?: number;
  descriptorReadLimit?: number;
}

function invalidType(path: string, expected: string, value: unknown): TypeError {
  const actual =
    value === null
      ? 'null'
      : Array.isArray(value)
        ? 'Array'
        : typeof value === 'object'
          ? 'Object'
          : typeof value;
  return Object.assign(
    new TypeError(`The "${path}" argument must be ${expected}. Received type ${actual}`),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
}

function outOfRange(path: string, expected: string, value: number): RangeError {
  return Object.assign(
    new RangeError(
      `The value of "${path}" is out of range. It must be ${expected}. Received ${value}`,
    ),
    { code: 'ERR_OUT_OF_RANGE' },
  );
}

/**
 * Validates and merges overrides onto the defaults. Invalid overrides use Node's
 * argument-validation conventions - `TypeError`/`ERR_INVALID_ARG_TYPE` for a
 * wrong shape or an unknown name, `RangeError`/`ERR_OUT_OF_RANGE` for a value
 * outside the bound - rather than the runtime error taxonomy, because this is a
 * caller mistake in a boot option, not a runtime limit being hit.
 */
export function resolveResourcePolicy(overrides?: ResourcePolicyOverrides): ResourcePolicy {
  if (overrides === undefined) return structuredPolicy({});
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides))
    throw invalidType('resources', 'an object', overrides);
  // Checked object, not null and not an array above; every own property is
  // validated by name and range below before it reaches the resolved policy.
  return structuredPolicy(overrides as Record<string, unknown>);
}

function structuredPolicy(overrides: Record<string, unknown>): ResourcePolicy {
  const groups = Object.keys(DEFAULT_RESOURCE_POLICY) as Array<keyof ResourcePolicy>;
  for (const name of Object.keys(overrides))
    if (!(groups as string[]).includes(name))
      throw invalidType(`resources.${name}`, 'a known resource group', undefined);
  const resolved: Record<string, Record<string, number>> = {};
  for (const group of groups) {
    // Every group of the policy is a flat record of numbers, by construction.
    const defaults = DEFAULT_RESOURCE_POLICY[group] as unknown as Record<string, number>;
    const values: Record<string, number> = { ...defaults };
    const supplied = overrides[group];
    if (supplied !== undefined) {
      if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied))
        throw invalidType(`resources.${group}`, 'an object', supplied);
      const maxima: Partial<Record<string, number>> = RESOURCE_POLICY_MAXIMA[group];
      for (const [key, value] of Object.entries(supplied as Record<string, unknown>)) {
        const path = `resources.${group}.${key}`;
        const removed = removedLimit(group, key);
        if (!removed && !Object.prototype.hasOwnProperty.call(defaults, key))
          throw invalidType(path, 'a known resource limit', undefined);
        if (value === undefined) continue;
        if (typeof value !== 'number') throw invalidType(path, 'a number', value);
        if (removed) {
          if (!Number.isSafeInteger(value) || value < 1)
            throw outOfRange(path, 'a positive safe integer', value);
          continue;
        }
        if (value === UNBOUNDED && unboundable(group, key)) {
          values[key] = value;
          continue;
        }
        if (!Number.isSafeInteger(value) || value < 1)
          throw outOfRange(
            path,
            unboundable(group, key)
              ? 'a positive safe integer or Infinity'
              : 'a positive safe integer',
            value,
          );
        const maximum = maxima[key];
        if (maximum !== undefined && value > maximum)
          throw outOfRange(path, `<= ${maximum}`, value);
        values[key] = value;
      }
    }
    resolved[group] = values;
  }
  // One entry per group, each a copy of that group's defaults with only
  // validated numeric overrides applied, so the shape matches the interface.
  return resolved as unknown as ResourcePolicy;
}

/**
 * Folds the deprecated per-limit boot aliases into a `resources` override. An
 * explicit `resources` entry wins, so the modern spelling is always the answer
 * when both are present.
 */
export function aliasResourceOverrides(
  overrides: ResourcePolicyOverrides | undefined,
  aliases: ResourcePolicyAliases,
): ResourcePolicyOverrides | undefined {
  const mapped: ResourcePolicyOverrides = {};
  if (aliases.httpResponseLimit !== undefined)
    mapped.http = { responseBytes: aliases.httpResponseLimit };
  if (aliases.unzipLimit !== undefined) mapped.install = { unzipBytes: aliases.unzipLimit };
  if (aliases.descriptorReadLimit !== undefined)
    mapped.filesystem = { descriptorReadBytes: aliases.descriptorReadLimit };
  if (!Object.keys(mapped).length) return overrides;
  if (overrides === undefined) return mapped;
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides))
    throw invalidType('resources', 'an object', overrides);
  const merged: Record<string, unknown> = { ...mapped };
  for (const [group, values] of Object.entries(overrides as Record<string, unknown>)) {
    const base = merged[group];
    merged[group] =
      typeof values === 'object' && values !== null && typeof base === 'object' && base !== null
        ? { ...(base as object), ...(values as object) }
        : values;
  }
  return merged as ResourcePolicyOverrides;
}

/** Outbound guest HTTP/HTTPS host allowlist and blocklist policy. */
export interface HttpEgressPolicy {
  /**
   * Allowed outbound guest HTTP/HTTPS host patterns (`example.com`,
   * `*.example.com`, `example.com:8443`, `*.example.com:8443`, `127.0.0.1:4450`,
   * `[::1]:8080`). When defined, every outbound guest HTTP/HTTPS request whose
   * target does not match at least one pattern is rejected with `EACCES`
   * before `fetch()`. An empty array denies all outbound HTTP/HTTPS requests.
   */
  allowedHosts?: readonly string[];
  /**
   * Blocked outbound guest HTTP/HTTPS host patterns (same syntax as
   * `allowedHosts`). Evaluated before `allowedHosts` (deny overrides allow).
   */
  blockedHosts?: readonly string[];
}

export interface HttpEgressRule {
  readonly mode: 'any' | 'exact' | 'subdomain';
  readonly host: string;
  readonly port?: number;
}

export interface ResolvedHttpEgressPolicy {
  readonly allowed?: readonly HttpEgressRule[];
  readonly allowedLayers?: readonly (readonly HttpEgressRule[])[];
  readonly blocked?: readonly HttpEgressRule[];
}

function canonicalizeHostKey(unbracketedLower: string): string {
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(unbracketedLower);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1]!, 16);
    const lo = Number.parseInt(mappedHex[2]!, 16);
    return `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
  }
  return unbracketedLower;
}

function parseEgressPort(raw: string): number {
  if (!/^\d+$/.test(raw)) throw fault('EINVAL', 'Invalid HTTP egress port pattern');
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1 || num > 65535)
    throw fault('EINVAL', 'HTTP egress port must be between 1 and 65535');
  return num;
}

function parseHttpEgressRule(raw: unknown): HttpEgressRule {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512 || raw.trim() !== raw)
    throw fault('EINVAL', 'Invalid HTTP egress host pattern');
  if (/[\s/?#@\\]/.test(raw) || raw.includes('://'))
    throw fault(
      'EINVAL',
      'HTTP egress pattern must be a host or host:port pattern without URL scheme or path',
    );
  if (raw.startsWith('[')) {
    const closeBracket = raw.indexOf(']');
    if (closeBracket <= 1 || raw.indexOf('[', 1) !== -1)
      throw fault('EINVAL', 'Invalid IPv6 HTTP egress pattern');
    const bracketed = raw.slice(0, closeBracket + 1);
    const rest = raw.slice(closeBracket + 1);
    let port: number | undefined;
    if (rest.length > 0) {
      if (!rest.startsWith(':')) throw fault('EINVAL', 'Invalid IPv6 HTTP egress port');
      port = parseEgressPort(rest.slice(1));
    }
    let parsed: URL;
    try {
      parsed = new URL(`http://${bracketed}`);
    } catch {
      throw fault('EINVAL', 'Invalid IPv6 HTTP egress host');
    }
    if (
      !parsed.hostname.startsWith('[') ||
      !parsed.hostname.endsWith(']') ||
      parsed.pathname !== '/' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw fault('EINVAL', 'Invalid IPv6 HTTP egress host');
    const host = canonicalizeHostKey(parsed.hostname.slice(1, -1).toLowerCase());
    return Object.freeze(
      port === undefined ? { mode: 'exact', host } : { mode: 'exact', host, port },
    );
  }
  if (raw.indexOf(':') !== raw.lastIndexOf(':')) {
    let parsed: URL;
    try {
      parsed = new URL(`http://[${raw}]`);
    } catch {
      throw fault('EINVAL', 'Invalid IPv6 HTTP egress host');
    }
    if (!parsed.hostname.startsWith('[') || !parsed.hostname.endsWith(']'))
      throw fault('EINVAL', 'Invalid IPv6 HTTP egress host');
    return Object.freeze({
      mode: 'exact',
      host: canonicalizeHostKey(parsed.hostname.slice(1, -1).toLowerCase()),
    });
  }
  const colonIdx = raw.indexOf(':');
  const hostPart = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
  const port = colonIdx === -1 ? undefined : parseEgressPort(raw.slice(colonIdx + 1));
  if (hostPart.length === 0) throw fault('EINVAL', 'Missing host in HTTP egress pattern');
  if (hostPart === '*')
    return Object.freeze(
      port === undefined ? { mode: 'any', host: '' } : { mode: 'any', host: '', port },
    );
  if (hostPart.startsWith('*.')) {
    const suffix = hostPart.slice(2);
    if (!suffix || suffix.startsWith('.') || suffix.endsWith('.') || suffix.includes('*'))
      throw fault('EINVAL', 'Invalid wildcard HTTP egress host pattern');
    let parsed: URL;
    try {
      parsed = new URL(`http://${suffix}`);
    } catch {
      throw fault('EINVAL', 'Invalid wildcard HTTP egress host pattern');
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      !parsed.hostname ||
      parsed.hostname.includes(':') ||
      /^\d+(?:\.\d+){3}$/.test(parsed.hostname)
    )
      throw fault('EINVAL', 'Invalid wildcard HTTP egress domain');
    const host = parsed.hostname.toLowerCase();
    return Object.freeze(
      port === undefined ? { mode: 'subdomain', host } : { mode: 'subdomain', host, port },
    );
  }
  if (hostPart.includes('*') || hostPart.startsWith('.') || hostPart.endsWith('.'))
    throw fault('EINVAL', 'Invalid HTTP egress host pattern');
  let parsed: URL;
  try {
    parsed = new URL(`http://${hostPart}`);
  } catch {
    throw fault('EINVAL', 'Invalid HTTP egress host pattern');
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname
  )
    throw fault('EINVAL', 'Invalid HTTP egress host pattern');
  const host = canonicalizeHostKey(
    parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1).toLowerCase()
      : parsed.hostname.toLowerCase(),
  );
  return Object.freeze(
    port === undefined ? { mode: 'exact', host } : { mode: 'exact', host, port },
  );
}

export function validateHttpEgressPolicy(
  egress?: unknown,
  allowedHostsAlias?: unknown,
  blockedHostsAlias?: unknown,
): ResolvedHttpEgressPolicy | undefined {
  if (
    isResolvedHttpEgressPolicy(egress) &&
    allowedHostsAlias === undefined &&
    blockedHostsAlias === undefined
  )
    return egress;
  if (egress !== undefined) {
    if (!record(egress)) throw fault('EINVAL', 'Invalid HTTP egress policy');
    for (const key of Object.keys(egress)) {
      if (key !== 'allowedHosts' && key !== 'blockedHosts')
        throw fault('EINVAL', `Unknown HTTP egress policy option: ${key}`);
    }
  }
  const parseList = (list: unknown): readonly HttpEgressRule[] | undefined => {
    if (list === undefined) return undefined;
    if (!Array.isArray(list) || list.length > 1024)
      throw fault('EINVAL', 'HTTP egress host list must be an array of at most 1024 patterns');
    return Object.freeze(list.map((entry) => parseHttpEgressRule(entry)));
  };
  const aliasAllowed = parseList(allowedHostsAlias);
  const aliasBlocked = parseList(blockedHostsAlias);
  const groupedAllowed = record(egress) ? parseList(egress.allowedHosts) : undefined;
  const groupedBlocked = record(egress) ? parseList(egress.blockedHosts) : undefined;
  const allowed = groupedAllowed ?? aliasAllowed;
  const blocked = groupedBlocked ?? aliasBlocked;
  if (allowed === undefined && blocked === undefined) return undefined;
  return Object.freeze({
    ...(allowed !== undefined ? { allowed } : {}),
    ...(blocked !== undefined ? { blocked } : {}),
  });
}

function isHttpEgressRule(value: unknown): value is HttpEgressRule {
  return (
    record(value) &&
    (value.mode === 'any' || value.mode === 'exact' || value.mode === 'subdomain') &&
    typeof value.host === 'string' &&
    value.host.length <= 512 &&
    (value.port === undefined ||
      (typeof value.port === 'number' &&
        Number.isInteger(value.port) &&
        value.port >= 1 &&
        value.port <= 65535))
  );
}

function isResolvedHttpEgressPolicy(value: unknown): value is ResolvedHttpEgressPolicy {
  if (!record(value)) return false;
  for (const key of Object.keys(value)) {
    if (key !== 'allowed' && key !== 'allowedLayers' && key !== 'blocked') return false;
  }
  if (
    value.allowed !== undefined &&
    (!Array.isArray(value.allowed) ||
      value.allowed.length > 1024 ||
      !value.allowed.every(isHttpEgressRule))
  )
    return false;
  if (
    value.allowedLayers !== undefined &&
    (!Array.isArray(value.allowedLayers) ||
      value.allowedLayers.length === 0 ||
      value.allowedLayers.length > 16 ||
      !value.allowedLayers.every(
        (layer) => Array.isArray(layer) && layer.length <= 1024 && layer.every(isHttpEgressRule),
      ))
  )
    return false;
  if (
    value.blocked !== undefined &&
    (!Array.isArray(value.blocked) ||
      value.blocked.length > 1024 ||
      !value.blocked.every(isHttpEgressRule))
  )
    return false;
  return (
    value.allowed !== undefined || value.allowedLayers !== undefined || value.blocked !== undefined
  );
}

export function intersectHttpEgressPolicies(
  hostPolicy: ResolvedHttpEgressPolicy | undefined,
  clientPolicy: ResolvedHttpEgressPolicy | undefined,
): ResolvedHttpEgressPolicy | undefined {
  if (!hostPolicy) return clientPolicy;
  if (!clientPolicy) return hostPolicy;
  const layers: (readonly HttpEgressRule[])[] = [];
  if (hostPolicy.allowed !== undefined) layers.push(hostPolicy.allowed);
  if (hostPolicy.allowedLayers !== undefined) layers.push(...hostPolicy.allowedLayers);
  if (clientPolicy.allowed !== undefined) layers.push(clientPolicy.allowed);
  if (clientPolicy.allowedLayers !== undefined) layers.push(...clientPolicy.allowedLayers);
  if (layers.length > 16)
    throw fault('EINVAL', 'Combined HTTP egress allowedLayers exceeds 16 layers');

  const blockedRules: HttpEgressRule[] = [
    ...(hostPolicy.blocked ?? []),
    ...(clientPolicy.blocked ?? []),
  ];
  if (blockedRules.length > 1024)
    throw fault('EINVAL', 'Combined HTTP egress blockedHosts exceeds 1024 patterns');

  if (layers.length === 0 && blockedRules.length === 0) return undefined;
  return Object.freeze({
    ...(layers.length === 1 ? { allowed: layers[0]! } : {}),
    ...(layers.length > 1 ? { allowedLayers: Object.freeze(layers) } : {}),
    ...(blockedRules.length > 0 ? { blocked: Object.freeze(blockedRules) } : {}),
  });
}

function matchesEgressRule(rule: HttpEgressRule, hostname: string, effectivePort: number): boolean {
  if (rule.port !== undefined && rule.port !== effectivePort) return false;
  if (rule.mode === 'any') return true;
  if (rule.mode === 'exact') return hostname === rule.host;
  return hostname.length > rule.host.length + 1 && hostname.endsWith(`.${rule.host}`);
}

export function matchesHttpEgressTarget(
  policy: ResolvedHttpEgressPolicy | undefined,
  url: URL,
): boolean {
  if (!policy) return true;
  const rawHost = url.hostname;
  let hostname: string;
  if (rawHost.startsWith('[') && rawHost.endsWith(']')) {
    hostname = canonicalizeHostKey(rawHost.slice(1, -1).toLowerCase());
  } else {
    let trimmed = rawHost.toLowerCase();
    if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1);
    if (trimmed.length === 0 || trimmed.endsWith('.')) return false;
    hostname = trimmed;
  }
  const effectivePort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (policy.blocked?.some((rule) => matchesEgressRule(rule, hostname, effectivePort)))
    return false;
  if (
    policy.allowed !== undefined &&
    !policy.allowed.some((rule) => matchesEgressRule(rule, hostname, effectivePort))
  )
    return false;
  if (
    policy.allowedLayers !== undefined &&
    !policy.allowedLayers.every((layer) =>
      layer.some((rule) => matchesEgressRule(rule, hostname, effectivePort)),
    )
  )
    return false;
  return true;
}

export function attachHttpEgressPolicy(
  policy: ResourcePolicy,
  egress: ResolvedHttpEgressPolicy | undefined,
): ResourcePolicy {
  if (!egress) return policy;
  // Invariant: structured-clone boot carrier preserves ResourcePolicy groups alongside validated httpEgress metadata.
  return Object.freeze({ ...policy, httpEgress: egress }) as ResourcePolicy;
}

/** Validates a policy that arrived over a boot message from the host. */
export function isResourcePolicy(value: unknown): value is ResourcePolicy {
  if (typeof value !== 'object' || value === null) return false;
  const supplied = value as Record<string, unknown>;
  for (const [group, defaults] of Object.entries(DEFAULT_RESOURCE_POLICY)) {
    const values = supplied[group];
    if (typeof values !== 'object' || values === null) return false;
    for (const key of Object.keys(defaults)) {
      const limit = (values as Record<string, unknown>)[key];
      if (limit === UNBOUNDED && unboundable(group, key)) continue;
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) return false;
    }
  }
  if (supplied.httpEgress !== undefined && !isResolvedHttpEgressPolicy(supplied.httpEgress))
    return false;
  return true;
}

/** Falls back to the defaults for a peer that did not send a policy. */
export function policyOrDefault(value: unknown): ResourcePolicy {
  return isResourcePolicy(value) ? value : DEFAULT_RESOURCE_POLICY;
}

// One realm, one policy, for the realm's whole lifetime. The host installs the
// resolved policy at boot, the kernel Worker on its `ready` handshake and each
// process Worker on its `boot` message, all before any guest code runs, so an
// enforcement site can read its bound without every factory between it and the
// boundary carrying a parameter. The service worker is the exception: it serves
// several containers at once, so it keeps each container's policy in its owner
// record and never reads this accessor.
let installed: ResourcePolicy = DEFAULT_RESOURCE_POLICY;
let installedHttpEgress: ResolvedHttpEgressPolicy | undefined;

/** Installs this realm's resolved policy before any guest code runs. */
export function installResourcePolicy(policy: ResourcePolicy): void {
  installed = policy;
  const rawEgress: unknown = Reflect.get(policy, 'httpEgress');
  installedHttpEgress = isResolvedHttpEgressPolicy(rawEgress) ? rawEgress : undefined;
}

/** This realm's resolved policy; the documented defaults until one arrives. */
export function resourceLimits(): ResourcePolicy {
  return installed;
}

/** This realm's resolved outbound HTTP egress policy, if configured at boot. */
export function httpEgressPolicy(): ResolvedHttpEgressPolicy | undefined {
  return installedHttpEgress;
}
