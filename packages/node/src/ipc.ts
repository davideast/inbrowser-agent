import type { EventEmitter } from 'events';
import { captured } from './context-hook';
import { decodeAdvanced, encodeAdvanced } from './ipc-codec';
import { VERSION, fault, record } from './protocol';
import { resourceLimits } from './resource-policy';

/**
 * Keeps a child's messages behind the output it wrote before sending them. The
 * channel is a direct port, while inherited and piped output is relayed through
 * the host, so without this a parent could act on a message before the bytes a
 * native child had already written. The child stamps what it has emitted; the
 * parent holds delivery until it has received that much.
 */
export interface IpcOutputOrder {
  /** Sender: output messages this process has emitted so far. */
  emitted?: () => number;
  /** Receiver: output messages received from the peer so far. */
  relayed?: () => number;
}

/**
 * A bounded serialization channel between two independent guest Workers.
 *
 * As in Node, a busy peer never ends the channel: a send completes as soon as
 * it is written to the port (or, once the queue is nearly full, when the peer
 * reads enough to make room, as Node's wait on a full pipe), and the peer reads
 * it when its event loop turns.
 * The receiver acknowledges each message when its event loop reads it, or,
 * before guest listeners are ready, when it delivers it. Acknowledgements only
 * bound memory (unread messages and bytes per direction) and let a disconnect
 * wait until everything sent has arrived. Nothing here has a
 * deadline. The channel ends when either side disconnects, when the owner of
 * the peer's process record reports its termination (`stop`), or when the peer
 * violates the protocol.
 */
export function attachIpc(
  target: EventEmitter,
  port: MessagePort,
  retain: () => void,
  release: () => void,
  listenerReferences = false,
  serialization: 'json' | 'advanced' = 'json',
  order: IpcOutputOrder = {},
) {
  const LIMIT = resourceLimits().child.ipcMessageBytes;
  const MESSAGES = resourceLimits().child.ipcQueuedMessages;
  const QUEUED = resourceLimits().child.ipcQueuedBytes;
  let connected = true;
  let closed = false;
  let held = false;
  let closing = false;
  let remoteClosing = false;
  let sentDisconnect = false;
  // The 'disconnect' event has been emitted or scheduled.
  let announced = false;
  let ready = !listenerReferences;
  let nextId = 0;
  let lastReceived = 0;
  let queuedBytes = 0;
  let outgoingBytes = 0;
  // `acked` once the sender has been told it may reuse the message's share of the bound.
  const incoming: Array<{ id: number; text: string; outputs: number; acked: boolean }> = [];
  let remoteOutputs = 0;
  const stamp = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
  // Ordering is best effort within the queue bound: a full queue delivers anyway.
  let overflowing = false;
  const settled = (outputs: number) => overflowing || !order.relayed || order.relayed() >= outputs;
  // Sent but not yet delivered by the peer: message id to its encoded size.
  const pending = new Map<number, number>();
  // Send callbacks waiting for room, as Node's wait when the pipe is full.
  const blocked: Array<(error: Error | null) => void> = [];
  // Room remains while one more maximum-size message would still be accepted.
  const room = () => pending.size < MESSAGES && outgoingBytes <= QUEUED - LIMIT;
  const unblock = () => {
    while (blocked.length && (closed || room())) {
      const complete = blocked.shift();
      queueMicrotask(() => {
        complete?.(null);
      });
    }
  };
  // channel.ref()/unref() replace the counted reference, as in Node. Accepted
  // sends and a disconnect in progress still finish before the channel lets go.
  let explicit: boolean | undefined;
  const sync = () => {
    const working = closing || pending.size > 0;
    const needed =
      !closed &&
      (explicit === undefined
        ? working ||
          !listenerReferences ||
          target.listenerCount('message') > 0 ||
          target.listenerCount('disconnect') > 0
        : explicit || working);
    if (needed === held) return;
    held = needed;
    if (held) retain();
    else release();
  };
  const notifyError = (error: Error, callback?: (error: Error | null) => void) => {
    queueMicrotask(() => {
      if (callback) callback(error);
      else target.emit('error', error);
    });
  };
  // A local disconnect() emits in its caller's context; a remote one in the channel's.
  let emitDisconnect = () => {
    target.emit('disconnect');
  };
  const announce = (later: boolean) => {
    if (announced) return;
    announced = true;
    if (later) queueMicrotask(emitDisconnect);
    else emitDisconnect();
  };
  /**
   * Ends the channel. Sends already completed, as Node's have once written to
   * the channel; what the peer had not read is lost with it, without an error.
   */
  const stop = () => {
    if (closed) return;
    closed = true;
    connected = false;
    Object.assign(target, { channel: null });
    // Tell a live peer, so it does not wait on deliveries that will never come.
    port.postMessage({ version: VERSION, type: 'disconnected' });
    port.close();
    target.removeListener('newListener', changed);
    target.removeListener('removeListener', changed);
    pending.clear();
    incoming.length = 0;
    queuedBytes = outgoingBytes = 0;
    // Node completes writes still waiting in a closed pipe without an error.
    unblock();
    try {
      announce(false);
    } finally {
      sync();
    }
  };
  const progressClose = () => {
    if (!closing || closed || !ready || incoming.length) return;
    if (remoteClosing) {
      // The peer stopped reading when it disconnected; only output it wrote
      // before disconnecting still has to come first.
      if (settled(remoteOutputs)) stop();
      return;
    }
    // Everything received before disconnect() has been delivered, so the event
    // follows on the caller's next turn, as in Node, whether or not the peer is
    // busy. The transport keeps the port until the peer has every send.
    announce(true);
    if (!sentDisconnect && pending.size === 0) {
      sentDisconnect = true;
      port.postMessage({ version: VERSION, type: 'disconnect', outputs: order.emitted?.() });
    }
  };
  // Delivery belongs to the channel, which the attaching context created; it
  // must not pick up the context of whichever listener registration drained it.
  const drain = captured(() => {
    while (!closed && ready && incoming.length) {
      if (!settled(incoming[0]?.outputs ?? 0)) break;
      const next = incoming.shift();
      if (next === undefined) break;
      const { id, text, acked } = next;
      queuedBytes -= new TextEncoder().encode(text).length;
      if (!acked) port.postMessage({ version: VERSION, type: 'ack', id });
      const message: unknown =
        serialization === 'advanced' ? decodeAdvanced(text) : JSON.parse(text);
      const reserved =
        record(message) &&
        typeof message.cmd === 'string' &&
        message.cmd.startsWith('NODE_') &&
        message.cmd.length > 5;
      target.emit(reserved ? 'internalMessage' : 'message', message, undefined);
    }
  });
  function changed(name: string | symbol) {
    if (name !== 'message' && name !== 'disconnect' && name !== 'internalMessage') return;
    queueMicrotask(() => {
      if (
        target.listenerCount('message') ||
        target.listenerCount('disconnect') ||
        target.listenerCount('internalMessage')
      )
        ready = true;
      sync();
      drain();
      progressClose();
    });
  }
  target.on('newListener', changed);
  target.on('removeListener', changed);
  Object.defineProperty(target, 'connected', { get: () => connected });
  Object.assign(target, {
    // Node's control object; null once either side disconnects.
    channel: {
      ref() {
        explicit = true;
        sync();
      },
      unref() {
        explicit = false;
        sync();
      },
    },
    send(message: unknown, callback?: unknown, ...extra: unknown[]) {
      if ((callback !== undefined && typeof callback !== 'function') || extra.length)
        throw fault('ENOSYS', 'IPC handle passing and send options are not supported');
      // The callable check above is the invariant for this callback shape.
      const done = callback as ((error: Error | null) => void) | undefined;
      if (!connected) {
        notifyError(fault('ERR_IPC_CHANNEL_CLOSED', 'IPC channel closed'), done);
        return false;
      }
      if (message === undefined) throw fault('ERR_MISSING_ARGS', 'IPC message is required');
      if (
        typeof message === 'function' ||
        typeof message === 'symbol' ||
        typeof message === 'bigint'
      )
        throw fault(
          'ERR_INVALID_ARG_TYPE',
          'IPC message must be a string, object, number or boolean',
        );
      const text = serialization === 'advanced' ? encodeAdvanced(message) : JSON.stringify(message);
      if (text === undefined) throw fault('ERR_INVALID_ARG_TYPE', 'Invalid IPC message');
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > LIMIT || pending.size >= MESSAGES || outgoingBytes + bytes > QUEUED)
        throw fault('E2BIG', 'IPC message or delivery queue exceeds limit');
      const id = ++nextId;
      pending.set(id, bytes);
      outgoingBytes += bytes;
      sync();
      port.postMessage({
        version: VERSION,
        type: 'message',
        id,
        text,
        outputs: order.emitted?.(),
      });
      // Written to the channel: Node completes the send now, not when the peer
      // reads it, unless the pipe is full; then it completes when there is room.
      if (done) {
        blocked.push(captured(done));
        unblock();
      }
      return true;
    },
    disconnect() {
      if (!connected) {
        target.emit('error', fault('ERR_IPC_DISCONNECTED', 'IPC is already disconnected'));
        return;
      }
      ready = true;
      connected = false;
      Object.assign(target, { channel: null });
      closing = true;
      emitDisconnect = captured(() => {
        target.emit('disconnect');
      });
      sync();
      drain();
      progressClose();
    },
  });
  port.onmessage = captured((event: MessageEvent<unknown>) => {
    const message = event.data;
    if (closed || !record(message) || message.version !== VERSION) return;
    if (message.type === 'message') {
      if (
        typeof message.id !== 'number' ||
        !Number.isSafeInteger(message.id) ||
        message.id <= lastReceived ||
        typeof message.text !== 'string'
      ) {
        stop();
        return;
      }
      if (announced) {
        // Node stops reading once it has disconnected; acknowledge and drop.
        lastReceived = message.id;
        port.postMessage({ version: VERSION, type: 'ack', id: message.id });
        return;
      }
      const bytes = new TextEncoder().encode(message.text).length;
      if (order.relayed && (incoming.length >= MESSAGES || queuedBytes + bytes > QUEUED)) {
        // The backlog is waiting on relayed output, not on the guest. Losing the
        // channel would be worse than delivering ahead of that output.
        overflowing = true;
        try {
          drain();
        } finally {
          overflowing = false;
        }
      }
      if (bytes > LIMIT || incoming.length >= MESSAGES || queuedBytes + bytes > QUEUED) {
        stop();
        return;
      }
      lastReceived = message.id;
      // Before guest listeners are ready, a message counts against the sender's
      // bound until it is delivered, so a sender that outpaces readiness gets
      // E2BIG instead of overflowing this queue. Once ready, only relayed output
      // can hold a message back, and that queue delivers anyway when full.
      incoming.push({
        id: message.id,
        text: message.text,
        outputs: stamp(message.outputs),
        acked: ready,
      });
      if (ready) port.postMessage({ version: VERSION, type: 'ack', id: message.id });
      queuedBytes += bytes;
      drain();
      progressClose();
    } else if (message.type === 'ack' && typeof message.id === 'number') {
      const bytes = pending.get(message.id);
      if (bytes === undefined) return;
      pending.delete(message.id);
      outgoingBytes -= bytes;
      unblock();
      progressClose();
      sync();
    } else if (message.type === 'disconnect') {
      connected = false;
      Object.assign(target, { channel: null });
      closing = remoteClosing = true;
      remoteOutputs = stamp(message.outputs);
      sync();
      drain();
      progressClose();
    } else if (message.type === 'disconnected') {
      stop();
    }
  });
  sync();
  return {
    stop,
    ready() {
      ready = true;
      drain();
      progressClose();
    },
    /** The receiver's relayed-output count moved; deliver what was waiting on it. */
    advance() {
      drain();
      progressClose();
    },
  };
}
