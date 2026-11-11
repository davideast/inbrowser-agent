import { fault, record } from './protocol';

/**
 * One standard stream of a child after Node's stdio normalization. A number is
 * a descriptor of the spawning process, including its own 0, 1 and 2.
 */
export type StdioSlot = 'pipe' | 'ignore' | 'inherit' | number;

export interface ChildStdio {
  slots: [StdioSlot, StdioSlot, StdioSlot];
  /** Whether one entry asked for the IPC channel. */
  ipc: boolean;
  /** Length of Node's `child.stdio`: one entry per configured descriptor. */
  entries: number;
}

type Inspect = (value: unknown) => string;

// A child's pipe streams stand where Node has native handles, which Node accepts
// as another child's stdio. Any other object without a descriptor is invalid there.
const handleStreams = new WeakSet<object>();
export function markHandleStream<T extends object>(stream: T): T {
  handleStreams.add(stream);
  return stream;
}

const invalidStdio = (value: unknown, inspect: Inspect) =>
  Object.assign(new TypeError(`The argument 'stdio' is invalid. Received ${inspect(value)}`), {
    code: 'ERR_INVALID_ARG_VALUE',
  });

/** Node's stdioStringToArray: the string shorthands, optionally with a channel. */
function stringStdio(value: string, inspect: Inspect, channel?: 'ipc'): unknown[] {
  let entries: unknown[];
  if (value === 'ignore' || value === 'pipe' || value === 'overlapped')
    entries = [value, value, value];
  else if (value === 'inherit') entries = [0, 1, 2];
  else throw invalidStdio(value, inspect);
  return channel ? [...entries, channel] : entries;
}

/**
 * Node's fork() preprocessing: a string becomes that shorthand plus the channel,
 * any other non-array falls back to `silent`, and an array must name the channel.
 */
export function forkStdio(stdio: unknown, silent: unknown, inspect: Inspect): unknown[] {
  if (typeof stdio === 'string') return stringStdio(stdio, inspect, 'ipc');
  if (!Array.isArray(stdio)) return stringStdio(silent ? 'pipe' : 'inherit', inspect, 'ipc');
  if (!stdio.includes('ipc'))
    throw fault(
      'ERR_CHILD_PROCESS_IPC_REQUIRED',
      "Forked processes must have an IPC channel, missing value 'ipc' in options.stdio",
    );
  // The caller's array is read once here, as Node reads it once in spawn.
  return Array.from(stdio);
}

/**
 * Node's getValidStdio for an asynchronous child, narrowed to what this runtime
 * can carry: three standard streams and one message channel. Shapes Node accepts
 * but the transport cannot represent reject with ENOSYS before any resource exists.
 */
export function normalizeStdio(value: unknown, inspect: Inspect): ChildStdio {
  const stdio = typeof value === 'string' ? stringStdio(value, inspect) : value;
  if (!Array.isArray(stdio)) throw invalidStdio(value, inspect);
  const entries = Math.max(3, stdio.length);
  const slots: [StdioSlot, StdioSlot, StdioSlot] = ['pipe', 'pipe', 'pipe'];
  let ipc = false;
  // Node's own errors come first, in entry order; a shape Node would run but this
  // transport cannot carry is reported only once the whole array is Node-valid.
  let unsupported: string | undefined;
  for (let index = 0; index < entries; index++) {
    // Holes and missing entries read as undefined, exactly as Node's reduce pads them.
    const raw: unknown = stdio[index];
    const entry = raw ?? (index < 3 ? 'pipe' : 'ignore');
    let slot: StdioSlot;
    if (entry === 'ignore' || entry === 'inherit') slot = entry;
    else if (entry === 'pipe' || entry === 'overlapped') slot = 'pipe';
    else if (typeof entry === 'number' && entry < 0) slot = 'pipe';
    else if (entry === 'ipc') {
      if (ipc) throw fault('ERR_IPC_ONE_PIPE', 'Child process can have only one IPC pipe');
      if (index < 3)
        unsupported ??=
          'An IPC channel in place of a standard stream is unsupported; put it after the three standard streams';
      ipc = true;
      continue;
    } else if (typeof entry === 'number' || (record(entry) && typeof entry.fd === 'number')) {
      const fd = typeof entry === 'number' ? entry : entry.fd;
      // Node aborts the process on a descriptor that is not a 32-bit integer.
      if (typeof fd !== 'number' || !Number.isInteger(fd) || fd > 0x7fffffff)
        throw fault('EINVAL', 'Child stdio descriptors must be 32-bit integers');
      if (fd < 0) throw fault('EINVAL', 'spawn EINVAL');
      slot = fd;
    } else if (typeof entry === 'string' || ArrayBuffer.isView(entry))
      throw Object.assign(
        new TypeError(
          `Asynchronous forks do not support Buffer, TypedArray, DataView or string input: ${inspect(entry)}`,
        ),
        { code: 'ERR_INVALID_SYNC_FORK_INPUT' },
      );
    else if (record(entry) && handleStreams.has(entry)) {
      unsupported ??= "Passing another child's pipe stream as child stdio is unsupported";
      continue;
    } else throw invalidStdio(entry, inspect);
    if (index < 3) slots[index] = slot;
    else if (slot !== 'ignore')
      unsupported ??= 'Child descriptors beyond the three standard streams are unsupported';
  }
  if (unsupported !== undefined) throw fault('ENOSYS', unsupported);
  return { slots, ipc, entries };
}
