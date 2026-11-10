import { fault } from './protocol';

type Subscriber = (message: unknown, name: unknown) => void;

function isSubscriber(value: unknown): value is Subscriber {
  return typeof value === 'function';
}

function unsupported(): never {
  throw fault('ENOSYS', 'Diagnostics tracing and async-context store binding are unsupported');
}

export function createDiagnosticsChannel() {
  // Owned by one process Worker; teardown releases its registry and listeners.
  // This does not reproduce Node's weak-reference garbage-collection policy.
  const channels = new Map<unknown, Channel>();

  class Channel {
    private subscribers: Subscriber[] = [];
    private active = false;
    constructor(public name: unknown) {
      channels.set(name, this);
    }
    get hasSubscribers(): boolean {
      return this.active;
    }
    subscribe(subscription: unknown): void {
      // Node activates an inactive channel before validating the subscriber.
      this.active = true;
      if (!isSubscriber(subscription))
        throw Object.assign(new TypeError('subscription must be a function'), {
          code: 'ERR_INVALID_ARG_TYPE',
        });
      this.subscribers = [...this.subscribers, subscription];
    }
    unsubscribe(subscription: unknown): boolean {
      const index = this.subscribers.findIndex((subscriber) => subscriber === subscription);
      if (index === -1) return false;
      this.subscribers = this.subscribers.filter((_, position) => position !== index);
      if (this.subscribers.length === 0) this.active = false;
      return true;
    }
    publish(message?: unknown): void {
      // Mutations during delivery affect the next publication, not this snapshot.
      const subscribers = this.subscribers;
      for (const subscriber of subscribers) {
        try {
          subscriber(message, this.name);
        } catch (error) {
          // Finish synchronous delivery, then use the process's fatal error path.
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    }
    bindStore = unsupported;
    unbindStore = unsupported;
    runStores = unsupported;
  }

  function channel(name: unknown): Channel {
    const existing = channels.get(name);
    if (existing) return existing;
    if (typeof name !== 'string' && typeof name !== 'symbol')
      throw Object.assign(new TypeError('channel must be a string or symbol'), {
        code: 'ERR_INVALID_ARG_TYPE',
      });
    return new Channel(name);
  }

  return {
    Channel,
    channel,
    hasSubscribers: (name: unknown) => channels.get(name)?.hasSubscribers ?? false,
    subscribe: (name: unknown, subscription: unknown) => channel(name).subscribe(subscription),
    unsubscribe: (name: unknown, subscription: unknown) => channel(name).unsubscribe(subscription),
    tracingChannel: unsupported,
  };
}
