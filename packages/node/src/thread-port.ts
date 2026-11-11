import { EventEmitter } from 'events';
import { captured } from './context-hook';
import { VERSION, fault, record } from './protocol';
import { resourceLimits } from './resource-policy';
import { snapshotThreadValue } from './thread-clone';
import { registerThreadPortReceiver } from './worker-threads-marks';

/** Bound supported structured-clone graphs before handing ownership to the browser. */
export function threadValueSize(value: unknown): number {
  const {
    threadMessageBytes: LIMIT,
    threadGraphNodes: NODES,
    threadGraphEdges: EDGES,
    threadGraphDepth: DEPTH,
  } = resourceLimits().child;
  const seen = new Set<object>();
  const buffers = new Set<ArrayBufferLike>();
  let bytes = 0;
  let visits = 0;
  let slots = 0;
  const visit = (value: unknown, depth: number) => {
    if (++visits > EDGES || depth > DEPTH) throw fault('E2BIG', 'Thread graph exceeds limits');
    bytes += typeof value === 'string' || typeof value === 'bigint' ? String(value).length * 2 : 8;
    if (bytes > LIMIT) throw fault('E2BIG', 'Thread message exceeds limit');
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (seen.size > NODES) throw fault('E2BIG', 'Thread graph exceeds node limit');
    if (
      value instanceof ArrayBuffer ||
      value instanceof SharedArrayBuffer ||
      ArrayBuffer.isView(value)
    ) {
      const buffer = ArrayBuffer.isView(value) ? value.buffer : value;
      if (!buffers.has(buffer)) {
        buffers.add(buffer);
        bytes += buffer.byteLength;
      }
    } else if (value instanceof Date || value instanceof RegExp) bytes += String(value).length * 2;
    else if (value instanceof Map)
      for (const [key, item] of value) {
        visit(key, depth + 1);
        visit(item, depth + 1);
      }
    else if (value instanceof Set) for (const item of value) visit(item, depth + 1);
    else if (
      Array.isArray(value) ||
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null
    ) {
      if (Array.isArray(value)) {
        slots += value.length;
        if (slots > 1048576) throw fault('E2BIG', 'Thread arrays exceed limit');
      }
      for (const key of Object.keys(value)) {
        bytes += key.length * 2;
        visit(Reflect.get(value, key), depth + 1);
      }
    } else throw fault('ENOSYS', 'Unsupported thread message object');
    if (bytes > LIMIT) throw fault('E2BIG', 'Thread message exceeds limit');
  };
  visit(value, 0);
  return bytes;
}

/**
 * One end of a worker_threads message channel between two guest Workers.
 *
 * As in Node, a busy peer never ends the port: postMessage queues the message and
 * the peer reads it when its event loop turns. The receiver acknowledges each
 * message when it reads it; acknowledgements only bound memory (unread messages
 * and bytes per direction; a postMessage past either throws E2BIG) and let close()
 * wait until the peer has everything sent. Nothing here has a deadline. The port
 * ends when either side closes it, when the owner of the thread's record reports
 * its termination (`stop`), or when the peer violates the protocol.
 */
export function createThreadPort(
  port: MessagePort,
  retain: () => void,
  release: () => void,
  initiallyReady = false,
) {
  const LIMIT = resourceLimits().child.threadMessageBytes;
  const MESSAGES = resourceLimits().child.threadQueuedMessages;
  const QUEUED = resourceLimits().child.threadQueuedBytes;
  const target = new EventEmitter();
  let ready = initiallyReady;
  let closed = false;
  let closing = false;
  let held = false;
  let id = 0;
  let lastId = 0;
  let bytes = 0;
  let incomingBytes = 0;
  // Received but not yet read by this side's event loop.
  const incoming: Array<{ id: number; value: unknown; size: number }> = [];
  // Sent but not yet read by the peer: message id to its counted size.
  const pending = new Map<number, number>();
  const sync = () => {
    const needed = !closed && (pending.size > 0 || target.listenerCount('message') > 0);
    if (needed === held) return;
    held = needed;
    if (held) retain();
    else release();
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    port.close();
    pending.clear();
    incoming.length = 0;
    bytes = 0;
    incomingBytes = 0;
    target.removeListener('newListener', changed);
    target.removeListener('removeListener', changed);
    try {
      target.emit('close');
    } finally {
      sync();
    }
  };
  const finishClose = () => {
    if (!closed && closing && pending.size === 0) {
      port.postMessage({ version: VERSION, type: 'close' });
      stop();
    }
  };
  // Delivery belongs to the port, which the constructing context created.
  // A message is acknowledged when it is read here, so the sender's bound counts
  // what this side has not read yet.
  const drain = captured(() => {
    if (!ready || closed) return;
    while (incoming.length && !closed) {
      const next = incoming.shift();
      if (!next) break;
      incomingBytes -= next.size;
      port.postMessage({ version: VERSION, type: 'ack', id: next.id });
      target.emit('message', next.value);
    }
  });
  const changed = (name: string | symbol) => {
    if (name !== 'message') return;
    queueMicrotask(() => {
      if (target.listenerCount('message')) ready = true;
      sync();
      drain();
    });
  };
  target.on('newListener', changed);
  target.on('removeListener', changed);
  port.onmessage = captured((event: MessageEvent<unknown>) => {
    const message = event.data;
    if (closed || !record(message) || message.version !== VERSION) return;
    if (message.type === 'message') {
      if (
        !Number.isSafeInteger(message.id) ||
        typeof message.id !== 'number' ||
        message.id <= lastId
      ) {
        stop();
        return;
      }
      const size = threadValueSize(message.value);
      if (incoming.length >= MESSAGES || incomingBytes + size > QUEUED) {
        stop();
        return;
      }
      lastId = message.id;
      incomingBytes += size;
      incoming.push({ id: message.id, value: message.value, size });
      drain();
    } else if (message.type === 'ack' && typeof message.id === 'number') {
      const size = pending.get(message.id);
      if (size === undefined) return;
      pending.delete(message.id);
      bytes -= size;
      finishClose();
      sync();
    } else if (message.type === 'close') {
      ready = true;
      drain();
      stop();
    }
  });
  const api = Object.assign(target, {
    postMessage(value: unknown, transfer: unknown = []) {
      if (closed || closing) return;
      if (!Array.isArray(transfer) || !transfer.every((item) => item instanceof ArrayBuffer))
        throw fault('ENOSYS', 'Only ArrayBuffer transfer lists are supported');
      // Materialize accessors without prematurely copying transferred buffers.
      const snapshot = snapshotThreadValue(value, transfer);
      const size = threadValueSize([snapshot, transfer]);
      if (size > LIMIT || pending.size >= MESSAGES || bytes + size > QUEUED)
        throw fault('E2BIG', 'Thread delivery queue exceeds limit');
      const next = id + 1;
      port.postMessage({ version: VERSION, type: 'message', id: next, value: snapshot }, transfer);
      id = next;
      pending.set(next, size);
      bytes += size;
      sync();
    },
    close() {
      closing = true;
      finishClose();
    },
  });
  registerThreadPortReceiver(api, () => {
    if (closed || incoming.length === 0) return undefined;
    const next = incoming.shift();
    if (!next) return undefined;
    incomingBytes -= next.size;
    port.postMessage({ version: VERSION, type: 'ack', id: next.id });
    return { message: next.value };
  });
  return {
    api,
    stop,
    ready() {
      ready = true;
      drain();
      sync();
    },
  };
}
