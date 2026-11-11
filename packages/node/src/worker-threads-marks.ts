import { nodeError } from './node-errors';
import { record } from './protocol';

const untransferables = new WeakSet<object>();
const uncloneables = new WeakSet<object>();
const unrefedPorts = new WeakSet<MessagePort>();
const peerPorts = new WeakMap<MessagePort, MessagePort>();
const portQueues = new WeakMap<MessagePort, unknown[]>();
const threadPortReceivers = new WeakMap<object, () => { message: unknown } | undefined>();

export const NativeMessageChannel: typeof MessageChannel = globalThis.MessageChannel;

let channelSupportInstalled = false;

export function markAsUntransferable(object: unknown): void {
  if ((typeof object === 'object' && object !== null) || typeof object === 'function') {
    untransferables.add(object);
  }
}

export function isMarkedAsUntransferable(object: unknown): boolean {
  if ((typeof object !== 'object' || object === null) && typeof object !== 'function') {
    return false;
  }
  return untransferables.has(object);
}

export function markAsUncloneable(object: unknown): void {
  if ((typeof object === 'object' && object !== null) || typeof object === 'function') {
    uncloneables.add(object);
  }
}

export function isMarkedAsUncloneable(object: unknown): boolean {
  if ((typeof object !== 'object' || object === null) && typeof object !== 'function') {
    return false;
  }
  return uncloneables.has(object);
}

export function assertTransferableAllowed(transfer: readonly unknown[]): void {
  for (const item of transfer) {
    if (isMarkedAsUntransferable(item)) {
      throw new DOMException('Cannot transfer object of unsupported type.', 'DataCloneError');
    }
  }
}

export function assertCloneableGraph(root: unknown): void {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === null || (typeof cur !== 'object' && typeof cur !== 'function')) continue;
    if (isMarkedAsUncloneable(cur)) {
      throw new DOMException('Cannot clone object of unsupported type.', 'DataCloneError');
    }
    if (typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (cur instanceof Map) {
      for (const [k, v] of cur.entries()) {
        stack.push(k, v);
      }
    } else if (cur instanceof Set) {
      for (const item of cur.values()) {
        stack.push(item);
      }
    } else if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i++) {
        if (i in cur) stack.push(cur[i]);
      }
    } else if (!ArrayBuffer.isView(cur) && !(cur instanceof ArrayBuffer)) {
      for (const key of Object.keys(cur)) {
        const desc = Object.getOwnPropertyDescriptor(cur, key);
        if (desc && 'value' in desc) {
          stack.push(desc.value);
        }
      }
    }
  }
}

export function registerThreadPortReceiver(
  portApi: object,
  receiver: () => { message: unknown } | undefined,
): void {
  threadPortReceivers.set(portApi, receiver);
}

export function ensureChannelPrototypes(): void {
  if (typeof globalThis.BroadcastChannel === 'function') {
    const bcProto = globalThis.BroadcastChannel.prototype;
    if (typeof Reflect.get(bcProto, 'ref', bcProto) !== 'function') {
      Object.defineProperties(bcProto, {
        ref: {
          value: function ref(this: BroadcastChannel) {
            return this;
          },
          writable: true,
          enumerable: false,
          configurable: true,
        },
        unref: {
          value: function unref(this: BroadcastChannel) {
            return this;
          },
          writable: true,
          enumerable: false,
          configurable: true,
        },
      });
    }
  }

  if (typeof globalThis.MessagePort === 'function') {
    const mpProto = globalThis.MessagePort.prototype;
    if (typeof Reflect.get(mpProto, 'ref', mpProto) !== 'function') {
      Object.defineProperties(mpProto, {
        ref: {
          value: function ref(this: MessagePort) {
            unrefedPorts.delete(this);
            return this;
          },
          writable: true,
          enumerable: true,
          configurable: true,
        },
        unref: {
          value: function unref(this: MessagePort) {
            unrefedPorts.add(this);
            return this;
          },
          writable: true,
          enumerable: true,
          configurable: true,
        },
        hasRef: {
          value: function hasRef(this: MessagePort) {
            return !unrefedPorts.has(this);
          },
          writable: true,
          enumerable: true,
          configurable: true,
        },
      });
    }
  }

  if (channelSupportInstalled) return;
  channelSupportInstalled = true;

  if (
    typeof globalThis.MessageChannel === 'function' &&
    typeof globalThis.MessagePort === 'function'
  ) {
    const CurrentChannel = globalThis.MessageChannel;
    const WrappedChannel = function MessageChannel(this: unknown, ...args: unknown[]) {
      if (!new.target) {
        throw new TypeError("Class constructor MessageChannel cannot be invoked without 'new'");
      }
      // Reflect.construct invokes CurrentChannel (including async-context binding if installed) and returns a MessageChannel.
      const ch = Reflect.construct(CurrentChannel, args, new.target) as MessageChannel;
      peerPorts.set(ch.port1, ch.port2);
      peerPorts.set(ch.port2, ch.port1);
      return ch;
    };
    WrappedChannel.prototype = CurrentChannel.prototype;
    Object.defineProperty(WrappedChannel, 'name', { configurable: true, value: 'MessageChannel' });
    Object.defineProperty(globalThis, 'MessageChannel', {
      configurable: true,
      writable: true,
      value: WrappedChannel,
    });

    const mpProto = globalThis.MessagePort.prototype;
    const origPostMessage = mpProto.postMessage;
    const origClose = mpProto.close;

    Object.defineProperty(mpProto, 'postMessage', {
      configurable: true,
      writable: true,
      enumerable: true,
      value: function postMessage(this: MessagePort, value: unknown, transferOrOptions?: unknown) {
        const transferList = Array.isArray(transferOrOptions)
          ? transferOrOptions
          : record(transferOrOptions) && Array.isArray(transferOrOptions.transfer)
            ? transferOrOptions.transfer
            : undefined;
        if (transferList) {
          assertTransferableAllowed(transferList);
          for (const item of transferList) {
            if (item instanceof globalThis.MessagePort) {
              const peer = peerPorts.get(item);
              if (peer) peerPorts.delete(peer);
              peerPorts.delete(item);
              portQueues.delete(item);
            }
          }
        }
        assertCloneableGraph(value);
        const peer = peerPorts.get(this);
        if (peer && (!transferList || transferList.length === 0)) {
          const cloned = structuredClone(value);
          let q = portQueues.get(peer);
          if (!q) {
            q = [];
            portQueues.set(peer, q);
          }
          if (q.length < 1024) {
            q.push(cloned);
          }
          return Reflect.apply(origPostMessage, this, [cloned]);
        }
        if (arguments.length <= 1) {
          return Reflect.apply(origPostMessage, this, [value]);
        }
        return Reflect.apply(origPostMessage, this, [value, transferOrOptions]);
      },
    });

    Object.defineProperty(mpProto, 'close', {
      configurable: true,
      writable: true,
      enumerable: true,
      value: function close(this: MessagePort) {
        portQueues.delete(this);
        const peer = peerPorts.get(this);
        if (peer) peerPorts.delete(peer);
        peerPorts.delete(this);
        return Reflect.apply(origClose, this, []);
      },
    });
  }
}

export function receiveMessageOnPort(port: unknown): { message: unknown } | undefined {
  if (typeof port === 'object' && port !== null) {
    const threadReceiver = threadPortReceivers.get(port);
    if (threadReceiver) {
      return threadReceiver();
    }
  }
  if (typeof globalThis.MessagePort === 'function' && port instanceof globalThis.MessagePort) {
    const q = portQueues.get(port);
    if (!q || q.length === 0) return undefined;
    const message = q.shift();
    return { message };
  }
  throw nodeError(
    TypeError,
    'ERR_INVALID_ARG_TYPE',
    'The "port" argument must be an instance of MessagePort.',
  );
}

export function moveMessagePortToContext<T>(port: T, contextifiedSandbox: unknown): T {
  const isPort =
    (typeof port === 'object' && port !== null && threadPortReceivers.has(port)) ||
    (typeof globalThis.MessagePort === 'function' && port instanceof globalThis.MessagePort);
  if (!isPort) {
    throw nodeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      'The "port" argument must be an instance of MessagePort.',
    );
  }
  if (typeof contextifiedSandbox !== 'object' || contextifiedSandbox === null) {
    throw nodeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      'The "contextifiedSandbox" argument must be an object.',
    );
  }
  return port;
}
