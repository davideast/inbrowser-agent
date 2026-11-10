import { Buffer } from 'buffer';
import { Volume, createFsFromVolume } from 'memfs';
import path from 'path-browserify';
import { copyFileMode } from './copy-file-mode';
import { parseMountEntries } from './mount-entries';
import {
  CAPACITY,
  HEADER_BYTES,
  SEEK_CUR,
  SEEK_END,
  SEEK_SET,
  SYSCALL_FRAMING_SLACK,
  type StdioBindings,
  VERSION,
  createSyscallResponder,
  errorRecord,
  fault,
  isStdioBindings,
  record,
} from './protocol';
import { installResourcePolicy, policyOrDefault, resourceLimits } from './resource-policy';
import { type FilesystemSnapshot, type SnapshotEntry, parseSnapshot } from './snapshot';
import { TerminalInput } from './terminal-input';

interface VolumeUsage {
  inodes: number;
  bytes: number;
}
interface NodeAccounting {
  vol: MemfsVolumeShape;
  node: MemfsNodeShape;
  usage: VolumeUsage;
  links: number;
  fds: number;
  bytes: number;
  counted: boolean;
}
interface MemfsNodeShape {
  ino: number;
  nlink: number;
  perm: number;
  buf?: Uint8Array;
  canRead(): boolean;
  canWrite(): boolean;
  canExecute(): boolean;
  isDirectory(): boolean;
  isSymlink(): boolean;
  getSize(): number;
  write(buf: Uint8Array, off?: number, len?: number, pos?: number): number;
  truncate(len?: number): void;
  setBuffer(buf: Uint8Array): void;
  setString(str: string): void;
  makeSymlink(target: string): void;
}
interface MemfsLinkShape {
  vol: object;
  children: Map<string, MemfsLinkShape | undefined>;
  getNode(): MemfsNodeShape;
  setChild(name: string, link?: MemfsLinkShape): MemfsLinkShape;
  deleteChild(link: MemfsLinkShape): void;
}
interface MemfsFileShape {
  fd: number;
  node: MemfsNodeShape;
}
interface MemfsVolumeShape {
  openFiles: number;
  maxFiles: number;
  inodes: Record<number, MemfsNodeShape | undefined>;
  fds: Record<number, MemfsFileShape | undefined>;
  createNode(mode?: number): MemfsNodeShape;
  createLink(
    parent?: MemfsLinkShape | null,
    name?: string,
    isDirectory?: boolean,
    mode?: number,
  ): MemfsLinkShape;
  openFile(
    filename: string,
    flagsNum: number,
    modeNum?: number,
    resolveSymlinks?: boolean,
  ): MemfsFileShape;
  openLink(link: MemfsLinkShape, flagsNum: number, resolveSymlinks?: boolean): MemfsFileShape;
  closeFile(file: MemfsFileShape): void;
  unlinkBase(filename: string): void;
  symlinkBase(targetFilename: string, pathFilename: string): MemfsLinkShape;
  getLinkOrThrow(filename: string): MemfsLinkShape;
  deleteLink(link: MemfsLinkShape): boolean;
  deleteNode(node: MemfsNodeShape): void;
}

const volumeUsages = new WeakMap<object, VolumeUsage>();
const nodeAccountings = new WeakMap<object, NodeAccounting>();
const reachableLinks = new WeakSet<object>();
let bypassDescriptorQuota = false;
let openingFile = false;
let movingLink: MemfsLinkShape | undefined;
let inUnlinkBase = false;

function getVolumeUsage(vol: object): VolumeUsage {
  let usage = volumeUsages.get(vol);
  if (!usage) {
    usage = { inodes: 0, bytes: 0 };
    volumeUsages.set(vol, usage);
  }
  return usage;
}

function ensureInodeQuota(vol: object, delta: number): void {
  if (delta <= 0) return;
  const usage = getVolumeUsage(vol);
  // Every volume creates its root '/' inode at construction (inodes === 0 -> 1);
  // maxInodes >= 1 is validated by resolveResourcePolicy.
  const limit = resourceLimits().filesystem.maxInodes;
  const attempted = usage.inodes + delta;
  if (attempted > limit)
    throw fault('ENOSPC', `Filesystem inode count exceeds ${limit} inode limit`, {
      kind: 'limit',
      limit,
      actual: attempted,
    });
}

function ensureByteQuota(vol: object, delta: number): void {
  if (delta <= 0) return;
  const usage = getVolumeUsage(vol);
  const limit = resourceLimits().filesystem.maxTotalBytes;
  const attempted = usage.bytes + delta;
  if (attempted > limit)
    throw fault('ENOSPC', `Filesystem storage exceeds ${limit} byte limit`, {
      kind: 'limit',
      limit,
      actual: attempted,
    });
}

function ensureDescriptorQuota(vol: { openFiles: number }): void {
  if (bypassDescriptorQuota) return;
  const limit = resourceLimits().filesystem.maxOpenDescriptors;
  if (vol.openFiles >= limit)
    throw fault('EMFILE', `Open file descriptors exceed ${limit} descriptor limit`, {
      kind: 'limit',
      limit,
      actual: vol.openFiles + 1,
    });
}

function syncNodeAccounting(acc: NodeAccounting): void {
  const live = acc.links > 0 || acc.fds > 0;
  if (live && !acc.counted) {
    acc.counted = true;
    acc.usage.inodes += 1;
    acc.usage.bytes += acc.bytes;
  } else if (!live && acc.counted) {
    acc.counted = false;
    acc.usage.inodes -= 1;
    acc.usage.bytes -= acc.bytes;
    acc.vol.deleteNode(acc.node);
  }
}

function attachSubtree(rootLink: MemfsLinkShape): void {
  const stack: MemfsLinkShape[] = [rootLink];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || reachableLinks.has(current)) continue;
    reachableLinks.add(current);
    const acc = nodeAccountings.get(current.getNode());
    if (acc) {
      acc.links += 1;
      syncNodeAccounting(acc);
    }
    for (const [name, child] of current.children.entries()) {
      if (name === '.' || name === '..' || !child) continue;
      stack.push(child);
    }
  }
}

function detachSubtree(rootLink: MemfsLinkShape): void {
  const stack: MemfsLinkShape[] = [rootLink];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !reachableLinks.has(current)) continue;
    reachableLinks.delete(current);
    const acc = nodeAccountings.get(current.getNode());
    if (acc) {
      acc.links -= 1;
      if (!inUnlinkBase && !acc.node.isDirectory()) acc.node.nlink = acc.links;
      syncNodeAccounting(acc);
    }
    for (const [name, child] of current.children.entries()) {
      if (name === '.' || name === '..' || !child) continue;
      stack.push(child);
    }
  }
}

function checkNodeByteDelta(node: object, nextBytes: number): NodeAccounting | undefined {
  const acc = nodeAccountings.get(node);
  if (!acc) return undefined;
  const delta = nextBytes - acc.bytes;
  if (delta > 0 && acc.counted) {
    const limit = resourceLimits().filesystem.maxTotalBytes;
    const attempted = acc.usage.bytes + delta;
    if (attempted > limit)
      throw fault('ENOSPC', `Filesystem storage exceeds ${limit} byte limit`, {
        kind: 'limit',
        limit,
        actual: attempted,
      });
  }
  return acc;
}

function commitNodeBytes(acc: NodeAccounting | undefined, nextBytes: number): void {
  if (!acc) return;
  const delta = nextBytes - acc.bytes;
  if (acc.counted) acc.usage.bytes += delta;
  acc.bytes = nextBytes;
}

// Owner-bit permission and quota policy. The guest is a single user that owns
// every file it creates, so a native process is judged by the owner bits alone:
// group and other bits neither grant nor deny. memfs 4.17.0 ORs other, group and
// owner bits in Node.canRead/canWrite/canExecute (so 0o070 or 0o007 grants an
// owner access that Node denies), its open check requires write permission for
// every open, and its deleteLink/setChild paths neither reclaim overwritten
// nodes from volume.inodes nor bound aggregate bytes or inodes. Both permission
// and resource accounting are installed once on memfs's prototypes here without
// editing node_modules.
let readOnlyOpen = false;
function installKernelVolumePolicies() {
  const sample = new Volume();
  // Invariant: sample.getLinkOrThrow('/') and its getNode() are canonical memfs Link and Node instances.
  const rootLink = sample.getLinkOrThrow('/') as unknown as MemfsLinkShape;
  const linkProto = Object.getPrototypeOf(rootLink) as MemfsLinkShape;
  const nodeProto = Object.getPrototypeOf(rootLink.getNode()) as MemfsNodeShape;
  // Invariant: Volume.prototype implements the internal methods inspected in memfs 4.17.0.
  const volumeProto = Volume.prototype as unknown as MemfsVolumeShape;

  nodeProto.canRead = function (this: MemfsNodeShape) {
    return (this.perm & 0o400) !== 0;
  };
  nodeProto.canWrite = function (this: MemfsNodeShape) {
    return readOnlyOpen || (this.perm & 0o200) !== 0;
  };
  nodeProto.canExecute = function (this: MemfsNodeShape) {
    return (this.perm & 0o100) !== 0;
  };

  const originalNodeWrite = nodeProto.write;
  nodeProto.write = function (this: MemfsNodeShape, buf, off = 0, len = buf.byteLength, pos = 0) {
    const nextBytes = Math.max(this.getSize(), pos + len);
    const acc = checkNodeByteDelta(this, nextBytes);
    const written = originalNodeWrite.call(this, buf, off, len, pos);
    commitNodeBytes(acc, this.getSize());
    return written;
  };

  const originalNodeTruncate = nodeProto.truncate;
  nodeProto.truncate = function (this: MemfsNodeShape, len = 0) {
    const nextBytes = len ? len : 0;
    const acc = checkNodeByteDelta(this, nextBytes);
    originalNodeTruncate.call(this, len);
    commitNodeBytes(acc, this.getSize());
  };

  const originalSetBuffer = nodeProto.setBuffer;
  nodeProto.setBuffer = function (this: MemfsNodeShape, buf) {
    const nextBytes = Buffer.from(buf).byteLength;
    const acc = checkNodeByteDelta(this, nextBytes);
    originalSetBuffer.call(this, buf);
    commitNodeBytes(acc, this.getSize());
  };

  const originalSetString = nodeProto.setString;
  nodeProto.setString = function (this: MemfsNodeShape, str) {
    const nextBytes = Buffer.byteLength(str, 'utf8');
    const acc = checkNodeByteDelta(this, nextBytes);
    originalSetString.call(this, str);
    commitNodeBytes(acc, this.getSize());
  };

  const originalMakeSymlink = nodeProto.makeSymlink;
  nodeProto.makeSymlink = function (this: MemfsNodeShape, target) {
    const nextBytes = Buffer.byteLength(String(target), 'utf8');
    const acc = checkNodeByteDelta(this, nextBytes);
    originalMakeSymlink.call(this, target);
    commitNodeBytes(acc, nextBytes);
  };

  const originalSetChild = linkProto.setChild;
  linkProto.setChild = function (this: MemfsLinkShape, name: string, link?: MemfsLinkShape) {
    if (name !== '.' && name !== '..') {
      const existing = this.children.get(name);
      if (existing && existing !== link) this.deleteChild(existing);
    }
    const attached = originalSetChild.call(this, name, link);
    if (name !== '.' && name !== '..' && reachableLinks.has(this)) attachSubtree(attached);
    return attached;
  };

  const originalDeleteChild = linkProto.deleteChild;
  linkProto.deleteChild = function (this: MemfsLinkShape, link: MemfsLinkShape) {
    originalDeleteChild.call(this, link);
    if (link !== movingLink && reachableLinks.has(link)) detachSubtree(link);
  };

  const originalDeleteNode = volumeProto.deleteNode;
  volumeProto.deleteNode = function (this: MemfsVolumeShape, node: MemfsNodeShape) {
    const acc = nodeAccountings.get(node);
    if (acc && (acc.links > 0 || acc.fds > 0)) return;
    if (node.buf) node.buf = Buffer.alloc(0);
    if (this.inodes[node.ino] === node) originalDeleteNode.call(this, node);
  };

  const originalUnlinkBase = volumeProto.unlinkBase;
  volumeProto.unlinkBase = function (this: MemfsVolumeShape, filename: string) {
    const previous = inUnlinkBase;
    inUnlinkBase = true;
    try {
      originalUnlinkBase.call(this, filename);
    } finally {
      inUnlinkBase = previous;
    }
  };

  const originalCreateNode = volumeProto.createNode;
  volumeProto.createNode = function (this: MemfsVolumeShape, mode?: number) {
    ensureInodeQuota(this, 1);
    const node = originalCreateNode.call(this, mode);
    nodeAccountings.set(node, {
      vol: this,
      node,
      usage: getVolumeUsage(this),
      links: 0,
      fds: 0,
      bytes: 0,
      counted: false,
    });
    return node;
  };

  const originalCreateLink = volumeProto.createLink;
  volumeProto.createLink = function (
    this: MemfsVolumeShape,
    parent?: MemfsLinkShape | null,
    name?: string,
    isDirectory?: boolean,
    mode?: number,
  ) {
    // When openFile creates a new entry (O_CREAT), enforce descriptor capacity
    // before allocating or linking the inode so EMFILE leaves no empty file behind.
    if (parent && openingFile) ensureDescriptorQuota(this);
    return originalCreateLink.call(this, parent, name, isDirectory, mode);
  };

  const originalOpenFile = volumeProto.openFile;
  volumeProto.openFile = function (
    this: MemfsVolumeShape,
    filename: string,
    flagsNum: number,
    modeNum?: number,
    resolveSymlinks?: boolean,
  ) {
    const previous = openingFile;
    openingFile = true;
    try {
      return originalOpenFile.call(this, filename, flagsNum, modeNum, resolveSymlinks);
    } finally {
      openingFile = previous;
    }
  };

  const originalOpenLink = volumeProto.openLink;
  volumeProto.openLink = function (
    this: MemfsVolumeShape,
    link: MemfsLinkShape,
    flagsNum: number,
    resolveSymlinks?: boolean,
  ) {
    ensureDescriptorQuota(this);
    // The access mode is the low two bits; zero is O_RDONLY. memfs's own write
    // check cannot tell O_RDONLY apart (its test is `flags & O_RDONLY`, always 0).
    const previous = readOnlyOpen;
    readOnlyOpen = (flagsNum & 3) === 0;
    try {
      const file = originalOpenLink.call(this, link, flagsNum, resolveSymlinks);
      const acc = nodeAccountings.get(file.node);
      if (acc) {
        acc.fds += 1;
        syncNodeAccounting(acc);
      }
      return file;
    } finally {
      readOnlyOpen = previous;
    }
  };

  const originalCloseFile = volumeProto.closeFile;
  volumeProto.closeFile = function (this: MemfsVolumeShape, file: MemfsFileShape) {
    const wasOpen = Boolean(this.fds[file.fd]);
    originalCloseFile.call(this, file);
    if (wasOpen) {
      const acc = nodeAccountings.get(file.node);
      if (acc) {
        acc.fds -= 1;
        syncNodeAccounting(acc);
      }
    }
  };

  const originalSymlinkBase = volumeProto.symlinkBase;
  volumeProto.symlinkBase = function (
    this: MemfsVolumeShape,
    targetFilename: string,
    pathFilename: string,
  ) {
    try {
      return originalSymlinkBase.call(this, targetFilename, pathFilename);
    } catch (error) {
      // Roll back the uncommitted child link if makeSymlink rejected for maxTotalBytes.
      if (record(error) && error.code === 'ENOSPC') {
        try {
          const steps = pathFilename.split('/').filter(Boolean);
          const name = steps[steps.length - 1];
          const parentPath = '/' + steps.slice(0, -1).join('/');
          const dirLink = this.getLinkOrThrow(parentPath);
          const partial = name ? dirLink.children.get(name) : undefined;
          if (partial && !partial.getNode().isSymlink() && partial.getNode().getSize() === 0) {
            this.deleteLink(partial);
            this.deleteNode(partial.getNode());
          }
        } catch {
          /* Parent was never mutated when createNode threw ENOSPC for maxInodes. */
        }
      }
      throw error;
    }
  };
}
installKernelVolumePolicies();

function createTrackedVolume(): InstanceType<typeof Volume> {
  const created = new Volume();
  // Lift memfs's hardcoded 10,000-file ceiling so resourceLimits().filesystem.maxOpenDescriptors is the sole bound.
  created.maxFiles = Number.POSITIVE_INFINITY;
  // Invariant: created.root is a canonical memfs Link instance on every Volume.
  attachSubtree(created.root as unknown as MemfsLinkShape);
  return created;
}

let volume = createTrackedVolume();
let fs = createFsFromVolume(volume);

const hostWatchers = new Map<string, () => void>();

function hostWatch(token: unknown, filename: unknown, recursive: unknown, port: MessagePort) {
  if (
    typeof token !== 'string' ||
    token.length > 128 ||
    typeof filename !== 'string' ||
    typeof recursive !== 'boolean' ||
    !filename.startsWith('/')
  )
    throw fault('EINVAL', 'Invalid host watcher');
  if (hostWatchers.has(token)) throw fault('EEXIST', 'Watcher is already registered');
  const hostWatcherLimit = resourceLimits().filesystem.hostWatchers;
  if (hostWatchers.size >= hostWatcherLimit)
    throw fault('E2BIG', 'Watcher limit exceeded', {
      limit: hostWatcherLimit,
      actual: hostWatchers.size,
    });
  const queue: Array<{ event: string; filename: string | null; bytes: number }> = [];
  let bytes = 0;
  let credit = false;
  let ended = false;
  const flush = () => {
    if (!credit || !queue.length || ended) return;
    const change = queue.shift();
    if (!change) return;
    credit = false;
    bytes -= change.bytes;
    port.postMessage({
      version: VERSION,
      type: 'event',
      event: change.event,
      filename: change.filename,
    });
  };
  const watcher = fs.watch(filename, { recursive, encoding: 'utf8' }, (event, name) => {
    if (ended) return;
    const filename = name === null ? null : String(name);
    const length = filename === null ? 0 : new TextEncoder().encode(filename).byteLength;
    if (
      queue.length >= resourceLimits().filesystem.watchQueueEvents ||
      bytes + length > resourceLimits().filesystem.watchQueueBytes
    ) {
      fail(fault('E2BIG', 'Filesystem watch consumer fell behind'));
      return;
    }
    queue.push({ event, filename, bytes: length });
    bytes += length;
    flush();
  });
  const close = () => {
    if (ended) return;
    ended = true;
    watcher.close();
    hostWatchers.delete(token);
    queue.length = 0;
    bytes = 0;
    port.onmessage = null;
    port.close();
  };
  const fail = (error: unknown) => {
    if (ended) return;
    port.postMessage({ version: VERSION, type: 'error', error: errorRecord(error) });
    close();
  };
  watcher.on('error', fail);
  port.onmessage = (message: MessageEvent<unknown>) => {
    const data = message.data;
    if (
      !record(data) ||
      data.version !== VERSION ||
      (data.type !== 'next' && data.type !== 'close')
    ) {
      fail(fault('EPROTO', 'Invalid watcher request'));
      return;
    }
    if (data.type === 'close') close();
    else {
      credit = true;
      flush();
    }
  };
  hostWatchers.set(token, close);
}

function snapshot(): FilesystemSnapshot {
  const previousBypass = bypassDescriptorQuota;
  bypassDescriptorQuota = true;
  try {
    const entries: SnapshotEntry[] = [];
    const pending = ['/'];
    let bytes = 0;
    while (pending.length) {
      const filename = pending.pop();
      if (filename === undefined) break;
      if (entries.length >= resourceLimits().snapshot.entries)
        throw fault('E2BIG', 'Snapshot has too many entries');
      const stat = fs.lstatSync(filename);
      if (stat.isDirectory()) {
        entries.push({ path: filename, type: 'directory', mode: Number(stat.mode) & 0o7777 });
        for (const name of fs.readdirSync(filename).sort().reverse())
          pending.push(path.join(filename, String(name)));
      } else if (stat.isSymbolicLink()) {
        entries.push({
          path: filename,
          type: 'symlink',
          target: String(fs.readlinkSync(filename)),
        });
      } else if (stat.isFile()) {
        bytes += Number(stat.size);
        if (bytes > resourceLimits().snapshot.bytes)
          throw fault('E2BIG', 'Snapshot exceeds 128 MiB');
        const data = fs.readFileSync(filename);
        if (!(data instanceof Uint8Array))
          throw fault('EPROTO', 'Snapshot read returned nonbinary data');
        entries.push({
          path: filename,
          type: 'file',
          mode: Number(stat.mode) & 0o7777,
          data: new Uint8Array(data),
        });
      } else throw fault('ENOSYS', 'Snapshot entry type is unsupported');
    }
    return parseSnapshot(
      { version: 1, entries },
      resourceLimits().snapshot.entries,
      resourceLimits().snapshot.bytes,
    );
  } finally {
    bypassDescriptorQuota = previousBypass;
  }
}

function restore(value: unknown) {
  if (processes.size || listeners.size || hostWatchers.size || Object.keys(volume.fds).length)
    throw fault('EBUSY', 'Stop all processes before restoring a snapshot');
  const snapshot = parseSnapshot(
    value,
    resourceLimits().snapshot.entries,
    resourceLimits().snapshot.bytes,
  );
  const maxInodes = resourceLimits().filesystem.maxInodes;
  if (snapshot.entries.length > maxInodes)
    throw fault('ENOSPC', `Filesystem inode count exceeds ${maxInodes} inode limit`, {
      kind: 'limit',
      limit: maxInodes,
      actual: snapshot.entries.length,
    });
  let snapshotBytes = 0;
  for (const entry of snapshot.entries) {
    if (entry.type === 'file') snapshotBytes += entry.data.byteLength;
    else if (entry.type === 'symlink') snapshotBytes += Buffer.byteLength(entry.target, 'utf8');
  }
  const maxBytes = resourceLimits().filesystem.maxTotalBytes;
  if (snapshotBytes > maxBytes)
    throw fault('ENOSPC', `Filesystem storage exceeds ${maxBytes} byte limit`, {
      kind: 'limit',
      limit: maxBytes,
      actual: snapshotBytes,
    });
  // Populate a private candidate volume. No canonical state changes on failure.
  const candidate = createTrackedVolume();
  const next = createFsFromVolume(candidate);
  const entries = [...snapshot.entries].sort((a, b) => a.path.length - b.path.length);
  for (const entry of entries) {
    if (entry.type === 'directory') {
      if (entry.path !== '/') next.mkdirSync(entry.path);
    } else if (entry.type === 'symlink') next.symlinkSync(entry.target, entry.path);
    else {
      next.writeFileSync(entry.path, entry.data);
      next.chmodSync(entry.path, entry.mode);
    }
  }
  for (const entry of entries)
    if (entry.type === 'directory') next.chmodSync(entry.path, entry.mode);
  volume = candidate;
  fs = next;
}
type InputPipe = {
  chunks: Uint8Array[];
  offset: number;
  tailSize: number;
  size: number;
  ended: boolean;
  terminal?: TerminalInput;
};
type NonFileStamp = {
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};
type KernelDescriptor =
  | { kind: 'file'; memfsFd: number }
  | ({ kind: 'stdin'; pipe: InputPipe; tty: boolean } & NonFileStamp)
  | ({ kind: 'output'; stream: 'stdout' | 'stderr'; tty: boolean } & NonFileStamp);
const processes = new Map<
  number,
  {
    port: MessagePort;
    fds: Map<number, KernelDescriptor>;
    fileStdio: Set<number>;
    watchers: Map<number, ReturnType<typeof fs.watch>>;
    input: InputPipe;
    inputClosed: boolean;
    inputWriter: boolean;
    disposeTransport: () => void;
  }
>();
// memfs allocates descriptors in the signed 32-bit range. Private pending-spawn
// aliases use a disjoint range and still live in their owning process's table.
let nextDescriptorAlias = 0x80000000;
const listeners = new Map<number, number>();
const allowed = new Set([
  'constants',
  'accessSync',
  'readFileSync',
  'writeFileSync',
  'appendFileSync',
  'copyFileSync',
  'chmodSync',
  'statSync',
  'lstatSync',
  'mkdirSync',
  'readdirSync',
  'renameSync',
  'unlinkSync',
  'rmdirSync',
  'rmSync',
  'existsSync',
  'realpathSync',
  'readlinkSync',
  'symlinkSync',
  'openSync',
  'closeSync',
  'readSync',
  'writeSync',
  'fstatSync',
  'ftruncateSync',
  'lseekSync',
  'linkSync',
  'utimesSync',
  'lutimesSync',
  'futimesSync',
]);

// Removing an entry needs write and search permission on its parent directory.
// memfs 4.17.0 checks neither for unlink or rmdir, so the kernel does, with the
// same owner-bit predicates as every other permission check.
function requireWritableParent(filename: string) {
  const parent = volume.getResolvedLinkOrThrow(path.dirname(filename), 'unlink').getNode();
  if (!parent.canWrite() || !parent.canExecute())
    throw fault('EACCES', 'Parent directory is not writable');
}

function resolveEntryPath(filename: string, followFinal: boolean) {
  let steps = filename.split('/').filter(Boolean);
  let current = '/';
  let index = 0;
  let links = 0;
  let directoryRequired = filename.endsWith('/');
  while (index < steps.length) {
    const step = steps[index++];
    if (step === '.') continue;
    if (step === '..') {
      current = path.dirname(current);
      continue;
    }
    const candidate = path.join(current, step);
    const last = index === steps.length;
    let stat: InstanceType<typeof fs.Stats> | undefined;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (!record(error) || error.code !== 'ENOENT') throw error;
    }
    if (!stat && (!last || directoryRequired)) throw fault('ENOENT', 'Path does not exist');
    if (stat?.isSymbolicLink() && (followFinal || !last || directoryRequired)) {
      if (++links > 40) throw fault('ELOOP', 'Too many path symbolic links');
      const target = String(fs.readlinkSync(candidate));
      if (last && target.endsWith('/')) directoryRequired = true;
      const resolved = path.isAbsolute(target) ? target : current + '/' + target;
      steps = (resolved + '/' + steps.slice(index).join('/')).split('/').filter(Boolean);
      current = '/';
      index = 0;
      continue;
    }
    if (stat && (!last || directoryRequired) && !stat.isDirectory())
      throw fault('ENOTDIR', 'Path component is not a directory');
    if (last) return { filename: candidate, stat };
    current = candidate;
  }
  return { filename: current, stat: fs.lstatSync(current) };
}

function ensureFileWriteQuota(
  filename: string,
  payloadBytes: number,
  isAppend: boolean,
  truncatesExisting: boolean,
  exclusive: boolean,
): void {
  let target: ReturnType<typeof resolveEntryPath>;
  try {
    target = resolveEntryPath(filename, !exclusive);
  } catch (error) {
    if (record(error) && error.code === 'ELOOP') throw error;
    return;
  }
  if (exclusive && target.stat) return;
  if (target.stat) {
    if (!target.stat.isFile()) return;
    const existingNode = volume.getLinkOrThrow(target.filename).getNode();
    if (!existingNode.canWrite()) return;
    ensureDescriptorQuota(volume);
    const existingBytes = existingNode.getSize();
    const nextBytes = isAppend
      ? existingBytes + payloadBytes
      : truncatesExisting
        ? payloadBytes
        : Math.max(existingBytes, payloadBytes);
    ensureByteQuota(volume, nextBytes - existingBytes);
    return;
  }
  let parentEntry: ReturnType<typeof resolveEntryPath>;
  try {
    parentEntry = resolveEntryPath(path.dirname(target.filename), true);
  } catch {
    return;
  }
  if (!parentEntry.stat?.isDirectory()) return;
  const parentNode = volume.getLinkOrThrow(parentEntry.filename).getNode();
  if (!parentNode.canWrite() || !parentNode.canExecute()) return;
  ensureDescriptorQuota(volume);
  ensureInodeQuota(volume, 1);
  ensureByteQuota(volume, payloadBytes);
}

function ensureRecursiveMkdirQuota(filename: string): void {
  const steps = path.normalize(filename).split('/').filter(Boolean);
  let existingPrefix: ReturnType<typeof resolveEntryPath> | undefined;
  let existingDepth = 0;
  for (let i = steps.length; i >= 0; i--) {
    const candidate = '/' + steps.slice(0, i).join('/');
    try {
      const resolved = resolveEntryPath(candidate, true);
      if (resolved.stat) {
        existingPrefix = resolved;
        existingDepth = i;
        break;
      }
    } catch (error) {
      if (record(error) && error.code === 'ELOOP') throw error;
    }
  }
  if (!existingPrefix?.stat?.isDirectory() || existingDepth >= steps.length) return;
  const prefixNode = volume.getLinkOrThrow(existingPrefix.filename).getNode();
  if (!prefixNode.canWrite() || !prefixNode.canExecute()) return;
  ensureInodeQuota(volume, steps.length - existingDepth);
}

function copyFile(args: unknown[]): void {
  const [source, destination, suppliedMode] = args;
  if (
    args.length !== 3 ||
    typeof source !== 'string' ||
    typeof destination !== 'string' ||
    !path.isAbsolute(source) ||
    !path.isAbsolute(destination)
  )
    throw Object.assign(new TypeError('copyFile requires two absolute filesystem paths'), {
      code: 'ERR_INVALID_ARG_TYPE',
    });
  const mode = copyFileMode(suppliedMode);
  try {
    if (mode & fs.constants.COPYFILE_FICLONE_FORCE)
      throw fault('ENOSYS', 'Forced copy-on-write cloning is not implemented');
    // Walk each component without delegating link traversal to memfs, whose
    // resolver has no cycle bound. Every prefix passed to lstat is canonical.
    const sourcePath = resolveEntryPath(source, true);
    const sourceStat = sourcePath.stat;
    if (!sourceStat) throw fault('ENOENT', 'Copy source does not exist');
    if (!sourceStat.isFile()) throw fault('ENOSYS', 'copyFile supports regular source files');
    const exclusive = Boolean(mode & fs.constants.COPYFILE_EXCL);
    const target = resolveEntryPath(destination, !exclusive);
    if (exclusive && target.stat) throw fault('EEXIST', 'Copy destination already exists');
    // Preserve same-file identity and timestamps rather than rewriting bytes.
    if (target.stat?.ino === sourceStat.ino) return;
    const sourceNode = volume.getLinkOrThrow(sourcePath.filename).getNode();
    if (sourceNode.canRead()) {
      ensureDescriptorQuota(volume);
      ensureFileWriteQuota(destination, Number(sourceStat.size), false, true, exclusive);
    }
    fs.copyFileSync(sourcePath.filename, target.filename, mode);
    // Node copies source permission bits on both creation and replacement.
    fs.chmodSync(target.filename, Number(sourceStat.mode) & 0o7777);
  } catch (error) {
    if (record(error))
      Object.assign(error, { syscall: 'copyfile', path: source, dest: destination });
    throw error;
  }
}

function kernelPosixError(code: 'EBADF' | 'EAGAIN' | 'EINVAL' | 'ESPIPE', syscall: string): Error {
  const table: Record<'EBADF' | 'EAGAIN' | 'EINVAL' | 'ESPIPE', [number, string]> = {
    EBADF: [-9, 'bad file descriptor'],
    EAGAIN: [-11, 'resource temporarily unavailable'],
    EINVAL: [-22, 'invalid argument'],
    ESPIPE: [-29, 'invalid seek'],
  };
  const [errno, text] = table[code];
  return Object.assign(fault(code, `${code}: ${text}, ${syscall}`), { errno, syscall });
}

function descriptorSyscall(op: string): string {
  if (op === 'closeSync') return 'close';
  if (op === 'fstatSync') return 'fstat';
  if (op === 'ftruncateSync') return 'ftruncate';
  if (op === 'readSync' || op === 'readFileSync') return 'read';
  if (op === 'writeSync' || op === 'writeFileSync' || op === 'appendFileSync') return 'write';
  return op.endsWith('Sync') ? op.slice(0, -4) : op;
}

function fstatNonFile(desc: Exclude<KernelDescriptor, { kind: 'file' }>, options: unknown) {
  const mode = (desc.tty ? 0o020000 : 0o010000) | 0o600;
  const atime = new Date(desc.atimeMs);
  const mtime = new Date(desc.mtimeMs);
  const ctime = new Date(desc.ctimeMs);
  const birthtime = new Date(desc.birthtimeMs);
  if (record(options) && options.bigint === true) {
    const atimeMs = BigInt(Math.trunc(desc.atimeMs));
    const mtimeMs = BigInt(Math.trunc(desc.mtimeMs));
    const ctimeMs = BigInt(Math.trunc(desc.ctimeMs));
    const birthtimeMs = BigInt(Math.trunc(desc.birthtimeMs));
    return {
      dev: 0n,
      ino: 0n,
      mode: BigInt(mode),
      nlink: 1n,
      uid: 0n,
      gid: 0n,
      rdev: 0n,
      blksize: 4096n,
      blocks: 0n,
      size: 0n,
      atimeMs,
      mtimeMs,
      ctimeMs,
      birthtimeMs,
      atimeNs: atimeMs * 1_000_000n,
      mtimeNs: mtimeMs * 1_000_000n,
      ctimeNs: ctimeMs * 1_000_000n,
      birthtimeNs: birthtimeMs * 1_000_000n,
      atime,
      mtime,
      ctime,
      birthtime,
    };
  }
  return {
    dev: 0,
    ino: 0,
    mode,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    blksize: 4096,
    blocks: 0,
    size: 0,
    atimeMs: desc.atimeMs,
    mtimeMs: desc.mtimeMs,
    ctimeMs: desc.ctimeMs,
    birthtimeMs: desc.birthtimeMs,
    atime,
    mtime,
    ctime,
    birthtime,
  };
}

function drainInputPipe(pipe: InputPipe, maxBytes: number): Uint8Array {
  const result = new Uint8Array(Math.min(maxBytes, pipe.size));
  let written = 0;
  while (written < result.length) {
    const first = pipe.chunks[0];
    if (!first) throw fault('EPROTO', 'Missing input chunk');
    const available = pipe.chunks.length === 1 ? pipe.tailSize : first.length;
    const count = Math.min(available - pipe.offset, result.length - written);
    result.set(first.subarray(pipe.offset, pipe.offset + count), written);
    written += count;
    pipe.offset += count;
    if (pipe.offset === available) {
      pipe.chunks.shift();
      pipe.offset = 0;
    }
  }
  pipe.size -= result.length;
  return result;
}

function lseekDescriptor(pid: number, args: unknown[]): number {
  const process = processes.get(pid);
  if (pid !== 0 && !process) throw fault('ESRCH', 'Process exited');
  const [rawFd, rawOffset, rawWhence = SEEK_SET] = args;
  if (typeof rawFd !== 'number' || !Number.isSafeInteger(rawFd) || rawFd < 0)
    throw kernelPosixError('EBADF', 'lseek');
  const desc = process?.fds.get(rawFd);
  if (!desc) throw kernelPosixError('EBADF', 'lseek');
  if (desc.kind !== 'file') throw kernelPosixError('ESPIPE', 'lseek');
  const file = volume.fds[desc.memfsFd];
  if (!file) throw kernelPosixError('EBADF', 'lseek');
  const nodeType = file.node.mode & 0o170000;
  if (nodeType === 0o010000 || nodeType === 0o140000) throw kernelPosixError('ESPIPE', 'lseek');
  let offset: number;
  if (typeof rawOffset === 'bigint') {
    if (rawOffset < BigInt(Number.MIN_SAFE_INTEGER) || rawOffset > BigInt(Number.MAX_SAFE_INTEGER))
      throw kernelPosixError('EINVAL', 'lseek');
    offset = Number(rawOffset);
  } else if (typeof rawOffset === 'number' && Number.isSafeInteger(rawOffset)) {
    offset = rawOffset;
  } else {
    throw kernelPosixError('EINVAL', 'lseek');
  }
  let base: number;
  if (rawWhence === SEEK_SET) base = 0;
  else if (rawWhence === SEEK_CUR) base = file.position ?? 0;
  else if (rawWhence === SEEK_END) base = file.node.getSize();
  else throw kernelPosixError('EINVAL', 'lseek');
  const next = base + offset;
  if (!Number.isSafeInteger(next) || next < 0) throw kernelPosixError('EINVAL', 'lseek');
  file.position = next;
  return next;
}

/**
 * Sets access and modification times in seconds. A null time is libuv's
 * UV_FS_UTIME_OMIT (Node passes NaN for an invalid Date): that time is kept.
 * Paths are canonicalized here so link traversal keeps its cycle bound.
 */
function setTimes(
  owner: { fds: Map<number, KernelDescriptor> } | undefined,
  op: string,
  args: unknown[],
) {
  const [target, atime, mtime] = args;
  const time = (value: unknown) =>
    value === null || (typeof value === 'number' && Number.isFinite(value));
  if (args.length !== 3 || !time(atime) || !time(mtime))
    throw fault('EINVAL', 'Setting times requires a target and two times in seconds');
  let currentAtimeMs: number;
  let currentMtimeMs: number;
  let apply: (atime: number, mtime: number) => void;
  if (op === 'futimesSync') {
    const desc = typeof target === 'number' ? owner?.fds.get(target) : undefined;
    if (desc === undefined) throw kernelPosixError('EBADF', 'futime');
    if (desc.kind === 'file') {
      const stat = fs.fstatSync(desc.memfsFd);
      currentAtimeMs = Number(stat.atimeMs);
      currentMtimeMs = Number(stat.mtimeMs);
      apply = (a, m) => fs.futimesSync(desc.memfsFd, a, m);
    } else {
      currentAtimeMs = desc.atimeMs;
      currentMtimeMs = desc.mtimeMs;
      apply = (a, m) => {
        desc.atimeMs = a * 1000;
        desc.mtimeMs = m * 1000;
        desc.ctimeMs = Date.now();
      };
    }
  } else {
    if (typeof target !== 'string' || !target.startsWith('/'))
      throw fault('EINVAL', 'Setting times requires an absolute path');
    const entry = resolveEntryPath(target, op === 'utimesSync');
    if (!entry.stat) throw fault('ENOENT', 'Path does not exist');
    currentAtimeMs = Number(entry.stat.atimeMs);
    currentMtimeMs = Number(entry.stat.mtimeMs);
    apply = (a, m) =>
      op === 'utimesSync'
        ? fs.utimesSync(entry.filename, a, m)
        : fs.lutimesSync(entry.filename, a, m);
  }
  apply(
    typeof atime === 'number' ? atime : currentAtimeMs / 1000,
    typeof mtime === 'number' ? mtime : currentMtimeMs / 1000,
  );
}

function filesystem(pid: number, op: string, args: unknown[]): unknown {
  if (!allowed.has(op)) throw fault('ENOSYS', `Unsupported fs operation: ${op}`);
  if (op === 'lseekSync') return lseekDescriptor(pid, args);
  const process = processes.get(pid);
  if (pid !== 0 && !process) throw fault('ESRCH', 'Process exited');
  if (op === 'utimesSync' || op === 'lutimesSync' || op === 'futimesSync')
    return setTimes(process, op, args);
  if (op === 'constants') {
    if (args.length !== 0) throw fault('EINVAL', 'Filesystem constants takes no arguments');
    return { ...fs.constants, SEEK_SET, SEEK_CUR, SEEK_END };
  }
  if (op === 'accessSync') {
    const [filename, mode] = args;
    if (args.length !== 2 || typeof filename !== 'string' || !filename.startsWith('/'))
      throw fault('EINVAL', 'Access requires an absolute path');
    const entry = resolveEntryPath(filename, true);
    if (!entry.stat) throw fault('ENOENT', 'Access path does not exist');
    // Permission queries use the owner bits only (installOwnerBitPolicy), as Node
    // does for a non-root process that owns the file; group and other bits never
    // grant or deny. Every process acts as the owner of every file.
    if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 7)
      throw fault('EINVAL', 'Access mode must be an integer from 0 through 7');
    const node = volume.getLinkOrThrow(entry.filename).getNode();
    if (
      (mode & fs.constants.R_OK && !node.canRead()) ||
      (mode & fs.constants.W_OK && !node.canWrite()) ||
      (mode & fs.constants.X_OK && !node.canExecute())
    )
      throw fault('EACCES', 'Permission denied');
    return;
  }
  if (op === 'copyFileSync') return copyFile(args);
  if (op === 'renameSync' && typeof args[0] === 'string' && typeof args[1] === 'string') {
    const [source, destination] = args;
    try {
      const entry = resolveEntryPath(source, false);
      if (!entry.stat) throw fault('ENOENT', 'Rename source does not exist');
      const target = resolveEntryPath(destination, false);
      if (entry.filename === target.filename || (target.stat && entry.stat.ino === target.stat.ino))
        return;
      if (entry.stat.isDirectory()) {
        if (target.filename.startsWith(entry.filename + '/'))
          throw fault('EINVAL', 'Cannot rename a directory into its descendant');
        if (target.stat && !target.stat.isDirectory())
          throw fault('ENOTDIR', 'Rename target is not a directory');
        if (target.stat && fs.readdirSync(target.filename).length > 0)
          throw fault('ENOTEMPTY', 'Rename target directory is not empty');
      } else if (target.stat?.isDirectory()) throw fault('EISDIR', 'Rename target is a directory');
      if (entry.stat.isSymbolicLink()) {
        const parent = resolveEntryPath(path.dirname(target.filename), true);
        if (!parent.stat?.isDirectory()) throw fault('ENOTDIR', 'Rename parent is not a directory');
        const link = volume.getLinkOrThrow(entry.filename);
        const newParent = volume.getLinkOrThrow(parent.filename);
        if (
          !link.parent.getNode().canExecute() ||
          !link.parent.getNode().canWrite() ||
          !newParent.getNode().canExecute() ||
          !newParent.getNode().canWrite()
        )
          throw fault('EACCES', 'Rename parent is not writable');
        // Move the canonical link, preserving inode identity and its raw target.
        // memfs rename follows the final symlink and therefore cannot do this.
        if (target.stat) fs.unlinkSync(target.filename);
        const previousMoving = movingLink;
        // Invariant: volume.getLinkOrThrow returns a canonical memfs Link instance.
        movingLink = link as unknown as MemfsLinkShape;
        try {
          link.parent.deleteChild(link);
          link.name = path.basename(target.filename);
          link.steps = [...newParent.steps, link.name];
          newParent.setChild(link.name, link);
        } finally {
          movingLink = previousMoving;
        }
        return;
      }
      // Invariant: volume.getLinkOrThrow returns a canonical memfs Link instance.
      const moving = volume.getLinkOrThrow(entry.filename) as unknown as MemfsLinkShape;
      const previousMoving = movingLink;
      movingLink = moving;
      try {
        return fs.renameSync(entry.filename, target.filename);
      } finally {
        movingLink = previousMoving;
      }
    } catch (error) {
      if (record(error))
        Object.assign(error, { syscall: 'rename', path: source, dest: destination });
      throw error;
    }
  }
  if (op === 'rmSync' && typeof args[0] === 'string') {
    const filename = args[0];
    const options = args[1];
    if (options !== undefined && !record(options))
      throw fault('ERR_INVALID_ARG_TYPE', 'Removal options must be an object');
    for (const flag of ['force', 'recursive'])
      if (record(options) && options[flag] !== undefined && typeof options[flag] !== 'boolean')
        throw fault('ERR_INVALID_ARG_TYPE', 'Removal ' + flag + ' must be boolean');
    // memfs rm resolves the final link, skipping dangling links under force
    // and potentially deleting a live target. Remove the directory entry itself.
    try {
      const entry = resolveEntryPath(filename, false);
      if (entry.stat?.isSymbolicLink()) return fs.unlinkSync(entry.filename);
    } catch (error) {
      // Preserve the backend's force handling for missing intermediate paths.
      if (!record(error) || error.code !== 'ENOENT') throw error;
    }
  }
  if (op === 'rmdirSync' && typeof args[0] === 'string' && args[0].length > 0) {
    // Existence and type errors keep memfs's precedence; only a removable entry
    // is checked against its parent's permissions.
    const targetPath = args[0].startsWith('/') ? args[0] : '/' + args[0];
    const entry = resolveEntryPath(targetPath, false);
    if (entry.stat?.isDirectory() && entry.filename !== '/') requireWritableParent(entry.filename);
  }
  if (op === 'linkSync') {
    // A hard link: a second name for the same node. The source is not followed when it
    // is itself a symbolic link (Linux link(2)); directories cannot be linked.
    const [existing, created] = args;
    if (
      args.length !== 2 ||
      typeof existing !== 'string' ||
      typeof created !== 'string' ||
      !existing.startsWith('/') ||
      !created.startsWith('/')
    )
      throw fault('EINVAL', 'Link requires two absolute paths');
    const source = resolveEntryPath(existing, false);
    if (!source.stat) throw fault('ENOENT', 'Link source does not exist');
    if (source.stat.isDirectory())
      throw fault('EPERM', 'Hard links to directories are not permitted');
    const target = resolveEntryPath(created, false);
    if (target.stat) throw fault('EEXIST', 'Link destination already exists');
    requireWritableParent(target.filename);
    return fs.linkSync(source.filename, target.filename);
  }
  if (op === 'unlinkSync') {
    const filename = args[0];
    if (args.length !== 1 || typeof filename !== 'string' || !filename.startsWith('/'))
      throw Object.assign(new TypeError('Unlink requires an absolute path'), {
        code: 'ERR_INVALID_ARG_TYPE',
      });
    try {
      // memfs permits empty-directory unlink. Inspect the entry itself so a
      // symlink to a directory is still removable without affecting its target.
      const entry = resolveEntryPath(filename, false);
      if (!entry.stat) throw fault('ENOENT', 'Unlink path does not exist');
      if (entry.stat.isDirectory()) throw fault('EISDIR', 'Cannot unlink a directory');
      requireWritableParent(entry.filename);
      return fs.unlinkSync(entry.filename);
    } catch (error) {
      if (record(error)) Object.assign(error, { syscall: 'unlink', path: filename });
      throw error;
    }
  }
  if (typeof args[0] === 'number') {
    const descriptor = args[0];
    const sysName = descriptorSyscall(op);
    const desc = process?.fds.get(descriptor);
    if (desc === undefined) throw kernelPosixError('EBADF', sysName);
    if (op === 'closeSync') {
      process?.fds.delete(descriptor);
      process?.fileStdio.delete(descriptor);
      if (descriptor === 0 && process) process.inputClosed = true;
      if (desc.kind === 'file') closeUnownedDescriptor(desc.memfsFd);
      return;
    }
    if (desc.kind !== 'file') {
      if (op === 'fstatSync') return fstatNonFile(desc, args[1]);
      if (op === 'ftruncateSync') throw kernelPosixError('EINVAL', 'ftruncate');
      if (op === 'readSync') {
        if (desc.kind === 'output') throw kernelPosixError('EBADF', 'read');
        if (args[4] !== null && args[4] !== undefined) throw kernelPosixError('ESPIPE', 'read');
        const length = args[3];
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
          throw kernelPosixError('EINVAL', 'read');
        const readLimit = resourceLimits().filesystem.descriptorReadBytes;
        if (length > readLimit)
          throw fault('E2BIG', `Read exceeds ${readLimit} byte limit`, {
            limit: readLimit,
            actual: length,
          });
        if (length === 0)
          return { bytesRead: 0, buffer: args[1] === null ? new Uint8Array(0) : args[1] };
        if (desc.pipe.size > 0) {
          const chunk = drainInputPipe(desc.pipe, length);
          if (args[1] instanceof Uint8Array) {
            const off = typeof args[2] === 'number' ? args[2] : 0;
            args[1].set(chunk, off);
            return { bytesRead: chunk.byteLength, buffer: args[1] };
          }
          return { bytesRead: chunk.byteLength, buffer: chunk };
        }
        if (desc.pipe.ended)
          return { bytesRead: 0, buffer: args[1] === null ? new Uint8Array(0) : args[1] };
        throw kernelPosixError('EAGAIN', 'read');
      }
      if (op === 'writeSync') {
        if (desc.kind === 'stdin') throw kernelPosixError('EBADF', 'write');
        const posArg =
          typeof args[1] === 'string' ? (typeof args[2] === 'number' ? args[2] : null) : args[4];
        if (typeof posArg === 'number' && posArg >= 0) throw kernelPosixError('ESPIPE', 'write');
        return { outputStream: desc.stream };
      }
      throw kernelPosixError('EINVAL', sysName);
    }
    const actual = desc.memfsFd;
    args[0] = actual;
    if (op === 'ftruncateSync') {
      // memfs truncates through a read-only descriptor; the OS reports EINVAL for a
      // descriptor not open for writing (and a directory is never open for writing).
      const file = volume.fds[actual];
      if (!file) throw kernelPosixError('EBADF', 'ftruncate');
      if ((file.flags & 3) === 0) throw kernelPosixError('EINVAL', 'ftruncate');
      if (typeof args[1] !== 'number' || !Number.isSafeInteger(args[1]) || args[1] < 0)
        throw kernelPosixError('EINVAL', 'ftruncate');
    }
    if (op === 'readSync') {
      // memfs lets a write-only descriptor read; the OS reports EBADF.
      const file = volume.fds[actual];
      if (file && (file.flags & 3) === 1) throw kernelPosixError('EBADF', 'read');
    }
    if (op === 'writeSync') {
      // memfs lets a read-only descriptor write; the OS reports EBADF.
      const file = volume.fds[actual];
      if (file && (file.flags & 3) === 0) throw kernelPosixError('EBADF', 'write');
    }
  }
  const fn: unknown = Reflect.get(fs, op);
  if (typeof fn !== 'function') throw fault('ENOSYS', `Unsupported fs operation: ${op}`);
  if (op === 'readSync' && typeof args[0] === 'number' && args[1] === null) {
    const length = args[3];
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
      throw fault('EINVAL', 'Invalid descriptor read length');
    const readLimit = resourceLimits().filesystem.descriptorReadBytes;
    if (length > readLimit)
      throw fault('E2BIG', `Read exceeds ${readLimit} byte limit`, {
        limit: readLimit,
        actual: length,
      });
    const file = volume.fds[args[0]];
    if (!file) throw kernelPosixError('EBADF', 'read');
    const explicitPos =
      typeof args[4] === 'number' && Number.isSafeInteger(args[4]) && args[4] >= 0 ? args[4] : null;
    const savedPosition = file.position;
    const startPos = explicitPos ?? file.position ?? 0;
    if (file.node.isFile()) {
      const available = Math.max(0, file.node.getSize() - startPos);
      const toRead = Math.min(length, available);
      if (toRead === 0) return { bytesRead: 0, buffer: new Uint8Array(0) };
      const scratch = new Uint8Array(toRead);
      try {
        const count: unknown = Reflect.apply(fn, fs, [args[0], scratch, 0, toRead, explicitPos]);
        const n = typeof count === 'number' && count > 0 ? count : 0;
        return {
          bytesRead: n,
          buffer: n === scratch.byteLength ? scratch : scratch.subarray(0, n),
        };
      } finally {
        if (explicitPos !== null) file.position = savedPosition;
      }
    }
    const scratch = new Uint8Array(Math.min(length, 65536));
    try {
      const count: unknown = Reflect.apply(fn, fs, [
        args[0],
        scratch,
        0,
        scratch.byteLength,
        explicitPos,
      ]);
      const n = typeof count === 'number' && count > 0 ? count : 0;
      return { bytesRead: n, buffer: scratch.subarray(0, n) };
    } finally {
      if (explicitPos !== null) file.position = savedPosition;
    }
  }
  if (op === 'writeSync' && typeof args[0] === 'number') {
    const file = volume.fds[args[0]];
    if (!file) throw kernelPosixError('EBADF', 'write');
    let explicitWritePos: number | null = null;
    let writeBytes = 0;
    if (typeof args[1] === 'string') {
      const enc = typeof args[3] === 'string' && Buffer.isEncoding(args[3]) ? args[3] : 'utf8';
      writeBytes = Buffer.byteLength(args[1], enc);
      if (typeof args[2] === 'number' && Number.isSafeInteger(args[2]) && args[2] >= 0)
        explicitWritePos = args[2];
    } else if (args[1] instanceof Uint8Array) {
      const offset = args[2] ?? 0;
      const length =
        args[3] === undefined && typeof offset === 'number' ? args[1].byteLength - offset : args[3];
      if (
        typeof offset !== 'number' ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        offset + length > args[1].byteLength ||
        (args[4] != null &&
          args[4] !== -1 &&
          (typeof args[4] !== 'number' || !Number.isSafeInteger(args[4]) || args[4] < 0))
      )
        throw kernelPosixError('EINVAL', 'write');
      writeBytes = length;
      if (typeof args[4] === 'number' && args[4] >= 0) explicitWritePos = args[4];
    } else {
      throw kernelPosixError('EINVAL', 'write');
    }
    const writeLimit = resourceLimits().filesystem.descriptorWriteBytes;
    if (writeBytes > writeLimit)
      throw fault('E2BIG', `Write exceeds ${writeLimit} byte limit`, {
        limit: writeLimit,
        actual: writeBytes,
      });
    if (file.node.isFile()) {
      // POSIX / Node 22.18: a 0-byte write on a regular file returns 0 without
      // extending the file or advancing the cursor (whereas memfs calls allocUnsafe).
      if (writeBytes === 0) return 0;
      const startPos =
        (file.flags & fs.constants.O_APPEND) !== 0
          ? file.node.getSize()
          : (explicitWritePos ?? file.position ?? 0);
      if ((file.flags & fs.constants.O_APPEND) === 0 && startPos > file.node.getSize()) {
        if (startPos + writeBytes > writeLimit)
          throw fault('E2BIG', `Write exceeds ${writeLimit} byte limit`, {
            limit: writeLimit,
            actual: startPos + writeBytes,
          });
      }
      // Validate aggregate byte quota before ftruncateSync extends any sparse hole.
      checkNodeByteDelta(file.node, Math.max(file.node.getSize(), startPos + writeBytes));
      if ((file.flags & fs.constants.O_APPEND) === 0 && startPos > file.node.getSize()) {
        // memfs grows sparse holes with Buffer.allocUnsafe; pre-extending with
        // ftruncateSync zero-fills [oldSize, startPos) before writing at startPos.
        const saved = file.position;
        fs.ftruncateSync(args[0], startPos);
        file.position = saved;
      }
    }
    if (explicitWritePos !== null) {
      // memfs advances its cursor even for positioned I/O; Node leaves it unchanged.
      const position = file.position;
      try {
        return Reflect.apply(fn, fs, args);
      } finally {
        file.position = position;
      }
    }
  }
  if (op === 'readSync' && typeof args[0] === 'number') {
    const file = volume.fds[args[0]];
    if (!file) throw kernelPosixError('EBADF', 'read');
    if (typeof args[4] === 'number' && args[4] >= 0) {
      // memfs advances its cursor even for positioned I/O; Node leaves it unchanged.
      const position = file.position;
      if (file.node.isFile() && args[4] >= file.node.getSize())
        return { bytesRead: 0, buffer: args[1] };
      try {
        const count: unknown = Reflect.apply(fn, fs, args);
        return { bytesRead: count, buffer: args[1] };
      } finally {
        file.position = position;
      }
    }
    if (file.node.isFile() && (file.position ?? 0) >= file.node.getSize())
      return { bytesRead: 0, buffer: args[1] };
  }
  // memfs's lstat and readlink do not resolve a symbolic link that is not the last
  // component; the OS does. Resolve the leading components here, with the walker
  // that bounds link depth, and let memfs report the final component as it would.
  if ((op === 'lstatSync' || op === 'readlinkSync') && typeof args[0] === 'string') {
    if (args[0].length > 0) {
      const originalPath = args[0];
      const targetPath = originalPath.startsWith('/') ? originalPath : '/' + originalPath;
      try {
        args[0] = resolveEntryPath(targetPath, false).filename;
      } catch (error) {
        // A regular file used as a directory is ENOTDIR; any other failure (a missing
        // directory) is reported by memfs for the original path.
        if (record(error) && error.code === 'ENOTDIR')
          throw Object.assign(error, {
            syscall: op.slice(0, -4).toLowerCase(),
            path: originalPath,
          });
      }
    }
  }
  if (
    (op === 'writeFileSync' || op === 'appendFileSync') &&
    (typeof args[0] === 'string' || args[0] instanceof Uint8Array)
  ) {
    const rawTarget = typeof args[0] === 'string' ? args[0] : Buffer.from(args[0]).toString('utf8');
    if (rawTarget.length > 0) {
      const targetPath = rawTarget.startsWith('/') ? rawTarget : '/' + rawTarget;
      let payloadBytes: number | undefined;
      if (args[1] instanceof Uint8Array) payloadBytes = args[1].byteLength;
      else if (typeof args[1] === 'string') {
        const rawEnc =
          typeof args[2] === 'string'
            ? args[2]
            : record(args[2]) && typeof args[2].encoding === 'string'
              ? args[2].encoding
              : 'utf8';
        if (Buffer.isEncoding(rawEnc)) payloadBytes = Buffer.byteLength(args[1], rawEnc);
      }
      if (payloadBytes !== undefined) {
        const rawFlag = record(args[2]) ? args[2].flag : undefined;
        const isAppend =
          typeof rawFlag === 'string'
            ? rawFlag.startsWith('a')
            : typeof rawFlag === 'number'
              ? (rawFlag & fs.constants.O_APPEND) !== 0
              : op === 'appendFileSync';
        const truncatesExisting =
          typeof rawFlag === 'string'
            ? rawFlag.startsWith('w')
            : typeof rawFlag === 'number'
              ? (rawFlag & fs.constants.O_TRUNC) !== 0
              : op === 'writeFileSync';
        const exclusive =
          typeof rawFlag === 'string'
            ? rawFlag.includes('x')
            : typeof rawFlag === 'number'
              ? (rawFlag & fs.constants.O_EXCL) !== 0
              : false;
        ensureFileWriteQuota(targetPath, payloadBytes, isAppend, truncatesExisting, exclusive);
      }
    }
  }
  if (
    op === 'mkdirSync' &&
    typeof args[0] === 'string' &&
    record(args[1]) &&
    args[1].recursive === true
  ) {
    ensureRecursiveMkdirQuota(path.resolve('/', args[0]));
  }
  // memfs treats chmod as a modification and stamps mtime; the OS changes only the
  // mode and ctime. Restore the access and modification times around it.
  let kept: { atimeMs: number; mtimeMs: number } | undefined;
  if (op === 'chmodSync' && typeof args[0] === 'string') {
    try {
      const before = fs.statSync(args[0]);
      kept = { atimeMs: Number(before.atimeMs), mtimeMs: Number(before.mtimeMs) };
    } catch {
      // chmod below reports the missing or unreadable path itself.
    }
  }
  const value: unknown = Reflect.apply(fn, fs, args);
  if (kept && typeof args[0] === 'string')
    fs.utimesSync(args[0], kept.atimeMs / 1000, kept.mtimeMs / 1000);
  if (
    op === 'lstatSync' &&
    record(value) &&
    ((typeof value.mode === 'number' && (value.mode & 0o170000) === 0o120000) ||
      (typeof value.mode === 'bigint' && (value.mode & 0o170000n) === 0o120000n))
  ) {
    // memfs reports zero; a symlink's size is the byte length of its raw target.
    const target: unknown = Reflect.apply(fs.readlinkSync, fs, [args[0], 'buffer']);
    if (!(target instanceof Uint8Array)) throw fault('EPROTO', 'Invalid symbolic link target');
    value.size = typeof value.mode === 'bigint' ? BigInt(target.byteLength) : target.byteLength;
  }
  if (op === 'openSync' && typeof value === 'number')
    process?.fds.set(value, { kind: 'file', memfsFd: value });
  if (op === 'readSync') return { bytesRead: value, buffer: args[1] };
  return value;
}
function closeUnownedDescriptor(actual: number) {
  for (const process of processes.values())
    for (const held of process.fds.values())
      if (held.kind === 'file' && held.memfsFd === actual) return;
  fs.closeSync(actual);
}
function removeProcess(pid: number) {
  const process = processes.get(pid);
  if (!process) return;
  for (const watcher of process.watchers.values()) watcher.close();
  process.watchers.clear();
  process.disposeTransport();
  process.port.close();
  processes.delete(pid);
  const fileFds = new Set<number>();
  for (const held of process.fds.values()) if (held.kind === 'file') fileFds.add(held.memfsFd);
  for (const actual of fileFds) closeUnownedDescriptor(actual);
  for (const [port, owner] of listeners) if (owner === pid) listeners.delete(port);
}
function inputCall(pid: number, op: string, args: unknown[]): unknown {
  const owner = processes.get(pid);
  if (!owner) throw fault('ESRCH', 'Input owner exited');
  const pipe = owner.input;
  if (op === 'stdin.rawMode') {
    if (!pipe.terminal || owner.fileStdio.has(0)) throw fault('ENOTTY', 'Input is not a terminal');
    if (owner.inputClosed) throw fault('EBADF', 'Guest stdin is closed');
    pipe.terminal.setRaw(args[0]);
    return;
  }
  if (op === 'stdin.close') {
    owner.inputClosed = true;
    return;
  }
  if (op === 'stdin.write') {
    const packet = args[0];
    if (
      !owner.inputWriter ||
      pipe.ended ||
      !Array.from(processes.values()).some(
        (process) => process.input === pipe && !process.inputClosed,
      )
    )
      throw fault('EPIPE', 'Guest stdin is closed');
    if (packet !== null && (!(packet instanceof Uint8Array) || packet.length > 65536))
      throw fault('EINVAL', 'Invalid input packet');
    let bytes: Uint8Array | null = packet;
    if (bytes instanceof Uint8Array && pipe.terminal) {
      const received = pipe.terminal.receive(bytes, pipe.size);
      bytes = received.bytes;
      if (received.interrupted) {
        pipe.chunks.length = 0;
        pipe.size = pipe.offset = pipe.tailSize = 0;
        self.postMessage({ type: 'terminal-interrupt', version: VERSION, pid });
      }
    }
    if (bytes === null) pipe.ended = true;
    else {
      if (pipe.size + bytes.length > resourceLimits().child.pipeBytes)
        throw fault('E2BIG', 'Guest stdin buffer exceeds limit');
      let offset = 0;
      while (offset < bytes.length) {
        if (!pipe.chunks.length || pipe.tailSize === 65536) {
          pipe.chunks.push(new Uint8Array(65536));
          pipe.tailSize = 0;
        }
        const tail = pipe.chunks[pipe.chunks.length - 1];
        if (!tail) throw fault('EPROTO', 'Missing input tail');
        const count = Math.min(65536 - pipe.tailSize, bytes.length - offset);
        tail.set(bytes.subarray(offset, offset + count), pipe.tailSize);
        pipe.tailSize += count;
        offset += count;
      }
      pipe.size += bytes.length;
    }
    for (const process of processes.values())
      if (process.input === pipe && (!process.inputClosed || process.fds.has(0)))
        process.port.postMessage({ type: 'stdin-ready', version: VERSION });
    return;
  }
  if (op === 'stdin.read') {
    const length = args[0];
    if (!owner.fds.has(0)) throw kernelPosixError('EBADF', 'read');
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 65536)
      throw fault('EINVAL', 'Invalid input read size');
    if (!length) return new Uint8Array();
    if (owner.fileStdio.has(0)) {
      const desc = owner.fds.get(0);
      if (!desc || desc.kind !== 'file') throw fault('EBADF', 'Input descriptor is closed');
      const file = volume.fds[desc.memfsFd];
      if (file && file.node.isFile() && (file.position ?? 0) >= file.node.getSize()) return null;
      const bytes = new Uint8Array(length);
      const count = fs.readSync(desc.memfsFd, bytes, 0, length, null);
      return count > 0 ? bytes.subarray(0, count) : null;
    }
    if (!pipe.size) return pipe.ended ? null : false;
    return drainInputPipe(pipe, length);
  }
  throw fault('ENOSYS', 'Unsupported input operation');
}
function syscall(pid: number, op: string, args: unknown[]): unknown {
  if (op === 'lseek') return lseekDescriptor(pid, args);
  if (op === 'stdio.prepare') {
    const owner = processes.get(pid);
    if (!owner) throw fault('ESRCH', 'Process exited');
    const stdio = args[0];
    if (!isStdioBindings(stdio)) throw fault('EINVAL', 'Invalid stdio bindings');
    const actuals = stdio.map((binding, index) => {
      if (binding === null) return null;
      // 'inherit' names the owner's descriptor for the same slot. Every named
      // descriptor must still be open in the unified descriptor table; only
      // file-backed descriptors need an alias across async child startup.
      const source = binding === 'inherit' ? index : binding;
      const desc = owner.fds.get(source);
      if (!desc) throw fault('EBADF', 'Descriptor not owned by process');
      return desc.kind === 'file' ? desc.memfsFd : null;
    });
    if (nextDescriptorAlias > Number.MAX_SAFE_INTEGER - 3)
      throw fault('E2BIG', 'Descriptor alias range exhausted');
    const prepared: StdioBindings = [...stdio];
    for (const [index, actual] of actuals.entries()) {
      if (actual === null) continue;
      const alias = nextDescriptorAlias++;
      owner.fds.set(alias, { kind: 'file', memfsFd: actual });
      prepared[index] = alias;
    }
    return prepared;
  }
  if (op.startsWith('stdin.')) return inputCall(pid, op, args);
  if (op === 'watch' || op === 'unwatch') {
    const process = processes.get(pid);
    if (!process) throw fault('ESRCH', 'Process exited');
    const [id, filename, recursive, encoding] = args;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
      throw fault('EINVAL', 'Invalid watcher id');
    if (op === 'unwatch') {
      process.watchers.get(id)?.close();
      process.watchers.delete(id);
      return;
    }
    if (
      typeof filename !== 'string' ||
      !filename.startsWith('/') ||
      typeof recursive !== 'boolean' ||
      (encoding !== 'utf8' && encoding !== 'buffer')
    )
      throw fault('EINVAL', 'Invalid watcher request');
    if (process.watchers.has(id)) throw fault('EEXIST', 'Watcher id is already owned');
    if (process.watchers.size >= resourceLimits().filesystem.processWatchers)
      throw fault('E2BIG', 'Watcher limit exceeded');
    const watcher = fs.watch(filename, { recursive, encoding }, (event, name) => {
      process.port.postMessage({ type: 'watch', version: VERSION, id, event, filename: name });
    });
    watcher.on('error', (error: unknown) => {
      watcher.close();
      process.watchers.delete(id);
      process.port.postMessage({
        type: 'watch',
        version: VERSION,
        id,
        event: 'error',
        error: errorRecord(error),
      });
    });
    process.watchers.set(id, watcher);
    return;
  }
  if (op.startsWith('fs.')) return filesystem(pid, op.slice(3), args);
  if (op === 'listen') {
    const desired = args[0];
    if (typeof desired !== 'number' || !Number.isInteger(desired) || desired < 0 || desired > 65535)
      throw fault('EINVAL', 'Invalid port');
    let port = desired;
    if (port === 0) {
      port = 3000;
      while (listeners.has(port)) port++;
    }
    if (listeners.has(port)) throw fault('EADDRINUSE', 'Virtual port already in use');
    listeners.set(port, pid);
    return port;
  }
  if (op === 'closeServer') {
    const port = args[0];
    if (typeof port !== 'number' || listeners.get(port) !== pid)
      throw fault('EINVAL', 'Listener not owned by process');
    listeners.delete(port);
    return;
  }
  throw fault('ENOSYS', `Unsupported syscall: ${op}`);
}
function attach(
  pid: number,
  shared: SharedArrayBuffer,
  port: MessagePort,
  piped: unknown,
  inherited: unknown,
  descriptorParent: unknown,
  stdio: unknown,
  terminal: unknown,
) {
  if (processes.has(pid) || shared.byteLength !== HEADER_BYTES + CAPACITY)
    throw fault('EINVAL', 'Invalid process channel');
  const maxProcesses = resourceLimits().child.maxProcesses;
  if (processes.size >= maxProcesses)
    throw fault('EAGAIN', `Process count exceeds ${maxProcesses} process limit`, {
      kind: 'limit',
      limit: maxProcesses,
      actual: processes.size + 1,
    });
  if (
    typeof piped !== 'boolean' ||
    typeof terminal !== 'boolean' ||
    (terminal && !piped) ||
    (piped && inherited !== undefined) ||
    (inherited !== undefined && typeof inherited !== 'number')
  )
    throw fault('EINVAL', 'Invalid input attachment');
  const source = typeof inherited === 'number' ? processes.get(inherited) : undefined;
  if (inherited !== undefined && (!source || source.inputClosed))
    throw fault('EBADF', 'Inherited input is closed');
  if (
    !isStdioBindings(stdio) ||
    (descriptorParent !== undefined &&
      (typeof descriptorParent !== 'number' || !Number.isSafeInteger(descriptorParent)))
  )
    throw fault('EINVAL', 'Invalid stdio attachment');
  const parent = typeof descriptorParent === 'number' ? processes.get(descriptorParent) : undefined;
  const fds = new Map<number, KernelDescriptor>();
  const fileStdio = new Set<number>();
  // Validate the complete binding set before publishing any descriptor ownership.
  for (const [index, binding] of stdio.entries()) {
    if (binding === null) continue;
    if (!parent) throw fault('EBADF', 'Missing descriptor parent');
    const source = binding === 'inherit' ? index : binding;
    if (source < 3 && !parent.fileStdio.has(source)) continue;
    const desc = parent.fds.get(source);
    if (!desc || desc.kind !== 'file') throw fault('EBADF', 'Inherited descriptor is closed');
    fds.set(index, { kind: 'file', memfsFd: desc.memfsFd });
    fileStdio.add(index);
  }
  const input = source?.input ?? {
    chunks: [],
    offset: 0,
    size: 0,
    ended: !piped,
    tailSize: 0,
    terminal: terminal ? new TerminalInput() : undefined,
  };
  const now = Date.now();
  const stamp = (): NonFileStamp => ({
    atimeMs: now,
    mtimeMs: now,
    ctimeMs: now,
    birthtimeMs: now,
  });
  for (let index = 0; index < 3; index++) {
    if (fds.has(index)) continue;
    const binding = stdio[index];
    const sourceSlot = binding === 'inherit' ? index : binding;
    const parentDesc = sourceSlot !== null && parent ? parent.fds.get(sourceSlot) : undefined;
    const tty =
      Boolean(terminal) ||
      (parentDesc !== undefined && parentDesc.kind !== 'file' && parentDesc.tty);
    if (index === 0) fds.set(0, { kind: 'stdin', pipe: input, tty, ...stamp() });
    else
      fds.set(index, {
        kind: 'output',
        stream: index === 1 ? 'stdout' : 'stderr',
        tty,
        ...stamp(),
      });
  }
  const responder = createSyscallResponder(
    shared,
    (op, args) => syscall(pid, op, args),
    () => {
      const fsLimits = resourceLimits().filesystem;
      return (
        Math.max(
          CAPACITY,
          fsLimits.descriptorReadBytes,
          fsLimits.descriptorWriteBytes,
          fsLimits.fileReadBytes,
        ) + SYSCALL_FRAMING_SLACK
      );
    },
  );
  processes.set(pid, {
    port,
    fds,
    fileStdio,
    watchers: new Map(),
    input,
    inputClosed: false,
    inputWriter: piped,
    disposeTransport: () => responder.dispose(),
  });
  port.onmessage = (event: MessageEvent<unknown>) => {
    responder.handleMessage(event.data);
  };
  return [...fileStdio];
}
function executeAtomicMount(rawFiles: unknown): void {
  // Every entry is validated and canonicalized before the first write, so any
  // permission error, path type conflict, or quota violation fails the whole
  // mount with zero partial mutations.
  const mountEntries = parseMountEntries(rawFiles);
  if (mountEntries.length === 0) return;

  const plannedDirs = new Set<string>();
  const plannedNewFiles = new Map<
    string,
    { data: string | Uint8Array; bytes: number; mode?: number; writable: boolean }
  >();
  const plannedExistingFiles = new Map<
    MemfsNodeShape,
    {
      canonicalPath: string;
      data: string | Uint8Array;
      bytes: number;
      mode?: number;
      writable: boolean;
    }
  >();

  const lstatIfExists = (candidate: string): InstanceType<typeof fs.Stats> | undefined => {
    try {
      return fs.lstatSync(candidate);
    } catch (error) {
      if (record(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  };

  const resolveDirPath = (dirPath: string, createMissing: boolean): string => {
    let steps = dirPath.split('/').filter(Boolean);
    let current = '/';
    let links = 0;
    let index = 0;
    while (index < steps.length) {
      const step = steps[index++];
      if (step === undefined || step === '.') continue;
      if (step === '..') {
        current = path.dirname(current);
        continue;
      }
      const candidate = path.join(current, step);
      if (plannedNewFiles.has(candidate))
        throw fault('ENOTDIR', 'Path component is not a directory');
      if (plannedDirs.has(candidate)) {
        current = candidate;
        continue;
      }
      const stat = lstatIfExists(candidate);
      if (stat) {
        if (stat.isSymbolicLink()) {
          if (++links > 40) throw fault('ELOOP', 'Too many path symbolic links');
          const linkTarget = String(fs.readlinkSync(candidate));
          const resolved = path.isAbsolute(linkTarget) ? linkTarget : current + '/' + linkTarget;
          steps = (resolved + '/' + steps.slice(index).join('/')).split('/').filter(Boolean);
          current = '/';
          index = 0;
          continue;
        }
        if (!stat.isDirectory()) throw fault('ENOTDIR', 'Path component is not a directory');
        current = candidate;
        continue;
      }
      if (!createMissing) throw fault('ENOENT', 'Path does not exist');
      if (!plannedDirs.has(current)) {
        // Invariant: getNode() returns a canonical memfs Node instance.
        const parentNode = volume.getLinkOrThrow(current).getNode() as unknown as MemfsNodeShape;
        if (!parentNode.canWrite() || !parentNode.canExecute())
          throw fault('EACCES', 'Permission denied');
      }
      plannedDirs.add(candidate);
      current = candidate;
    }
    return current;
  };

  for (const { path: entryPath, data, mode } of mountEntries) {
    if (entryPath === '/' || entryPath.endsWith('/'))
      throw fault('EISDIR', 'Illegal operation on a directory');
    const rawDir = path.dirname(entryPath);
    const rawBase = path.basename(entryPath);
    if (!rawBase || rawBase === '.' || rawBase === '..')
      throw fault('EISDIR', 'Illegal operation on a directory');

    let parentCanonical = resolveDirPath(rawDir, true);
    let targetCanonical = path.join(parentCanonical, rawBase);

    let hops = 0;
    for (;;) {
      if (plannedDirs.has(targetCanonical))
        throw fault('EISDIR', 'Illegal operation on a directory');
      if (plannedNewFiles.has(targetCanonical)) break;
      const stat = lstatIfExists(targetCanonical);
      if (!stat || !stat.isSymbolicLink()) break;
      if (++hops > 40) throw fault('ELOOP', 'Too many path symbolic links');
      const linkTarget = String(fs.readlinkSync(targetCanonical));
      if (linkTarget.endsWith('/')) throw fault('EISDIR', 'Illegal operation on a directory');
      const nextRaw = path.isAbsolute(linkTarget)
        ? linkTarget
        : path.join(parentCanonical, linkTarget);
      const nextBase = path.basename(nextRaw);
      if (!nextBase || nextBase === '.' || nextBase === '..')
        throw fault('EISDIR', 'Illegal operation on a directory');
      parentCanonical = resolveDirPath(path.dirname(nextRaw), false);
      targetCanonical = path.join(parentCanonical, nextBase);
    }

    if (plannedDirs.has(targetCanonical)) throw fault('EISDIR', 'Illegal operation on a directory');

    const dataBytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
    const existingStat = lstatIfExists(targetCanonical);
    if (existingStat) {
      if (!existingStat.isFile()) throw fault('EISDIR', 'Illegal operation on a directory');
      // Invariant: getNode() returns a canonical memfs Node instance.
      const existingNode = volume
        .getLinkOrThrow(targetCanonical)
        .getNode() as unknown as MemfsNodeShape;
      const prevPlan = plannedExistingFiles.get(existingNode);
      const currentlyWritable = prevPlan ? prevPlan.writable : existingNode.canWrite();
      if (!currentlyWritable) throw fault('EACCES', 'Permission denied');
      const finalMode = mode !== undefined ? mode : prevPlan?.mode;
      const nextWritable = mode !== undefined ? (mode & 0o200) !== 0 : currentlyWritable;
      plannedExistingFiles.set(existingNode, {
        canonicalPath: targetCanonical,
        data,
        bytes: dataBytes,
        mode: finalMode,
        writable: nextWritable,
      });
    } else {
      const prevNew = plannedNewFiles.get(targetCanonical);
      if (prevNew) {
        if (!prevNew.writable) throw fault('EACCES', 'Permission denied');
        const finalMode = mode !== undefined ? mode : prevNew.mode;
        const nextWritable = mode !== undefined ? (mode & 0o200) !== 0 : prevNew.writable;
        plannedNewFiles.set(targetCanonical, {
          data,
          bytes: dataBytes,
          mode: finalMode,
          writable: nextWritable,
        });
      } else {
        if (!plannedDirs.has(parentCanonical)) {
          // Invariant: getNode() returns a canonical memfs Node instance.
          const parentNode = volume
            .getLinkOrThrow(parentCanonical)
            .getNode() as unknown as MemfsNodeShape;
          if (!parentNode.canWrite() || !parentNode.canExecute())
            throw fault('EACCES', 'Permission denied');
        }
        plannedNewFiles.set(targetCanonical, {
          data,
          bytes: dataBytes,
          mode,
          writable: mode !== undefined ? (mode & 0o200) !== 0 : true,
        });
      }
    }
  }

  ensureDescriptorQuota(volume);
  ensureInodeQuota(volume, plannedDirs.size + plannedNewFiles.size);
  let byteDelta = 0;
  for (const plan of plannedNewFiles.values()) byteDelta += plan.bytes;
  for (const [node, plan] of plannedExistingFiles) byteDelta += plan.bytes - node.getSize();
  ensureByteQuota(volume, byteDelta);

  // Shrink existing files first so peak in-flight bytes never exceed maxTotalBytes.
  for (const [node, plan] of plannedExistingFiles) {
    if (plan.bytes < node.getSize()) node.truncate(plan.bytes);
  }
  const sortedDirs = [...plannedDirs].sort((a, b) => a.length - b.length);
  for (const dir of sortedDirs) fs.mkdirSync(dir, { recursive: true });
  for (const plan of plannedExistingFiles.values()) {
    fs.writeFileSync(plan.canonicalPath, plan.data);
    if (plan.mode !== undefined) fs.chmodSync(plan.canonicalPath, plan.mode);
  }
  for (const [canonicalPath, plan] of plannedNewFiles) {
    fs.writeFileSync(canonicalPath, plan.data);
    if (plan.mode !== undefined) fs.chmodSync(canonicalPath, plan.mode);
  }
}

self.onmessage = (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (!record(request) || typeof request.id !== 'number' || typeof request.op !== 'string') return;
  try {
    let value: unknown;
    if (request.op === 'ready') {
      // The host's resolved policy arrives with the version handshake, before
      // any process attaches, so every kernel bound below reads from it.
      installResourcePolicy(policyOrDefault(request.resources));
      value = VERSION;
    } else if (request.op === 'hostWatch' && request.port instanceof MessagePort)
      hostWatch(request.token, request.path, request.recursive, request.port);
    else if (request.op === 'hostUnwatch' && typeof request.token === 'string')
      hostWatchers.get(request.token)?.();
    else if (request.op === 'snapshot') value = snapshot();
    else if (request.op === 'restore') restore(request.snapshot);
    else if (
      request.op === 'stdin' &&
      typeof request.pid === 'number' &&
      Number.isSafeInteger(request.pid) &&
      request.pid > 0 &&
      (request.bytes === null || request.bytes instanceof Uint8Array)
    )
      value = inputCall(request.pid, 'stdin.write', [request.bytes]);
    else if (request.op === 'resources')
      value = {
        processes: processes.size,
        descriptors: Object.keys(volume.fds).length,
        listeners:
          listeners.size +
          hostWatchers.size +
          Array.from(processes.values()).reduce(
            (count, process) => count + process.watchers.size,
            0,
          ),
      };
    else if (
      request.op === 'attach' &&
      typeof request.pid === 'number' &&
      request.shared instanceof SharedArrayBuffer &&
      request.port instanceof MessagePort
    )
      value = attach(
        request.pid,
        request.shared,
        request.port,
        request.stdinPipe,
        request.stdinParent,
        request.descriptorParent,
        request.stdio,
        request.terminal,
      );
    else if (request.op === 'remove' && typeof request.pid === 'number') removeProcess(request.pid);
    else if (request.op === 'mount' && record(request.files)) {
      executeAtomicMount(request.files);
    } else if (
      request.op === 'fs' &&
      typeof request.method === 'string' &&
      Array.isArray(request.args)
    )
      value = filesystem(0, request.method, request.args);
    else if (request.op === 'lookup' && typeof request.port === 'number')
      value = listeners.get(request.port);
    else throw fault('EINVAL', 'Invalid kernel request');
    self.postMessage({ id: request.id, ok: true, value });
  } catch (error) {
    if (
      (request.op === 'attach' || request.op === 'hostWatch') &&
      request.port instanceof MessagePort
    )
      request.port.close();
    self.postMessage({ id: request.id, ok: false, error: errorRecord(error) });
  }
};
