// Entrypoint wrapper around Node.js v22.18.0 `lib/events.js` that installs the
// browser `EventTarget` listener/warning bridge once per Worker and preserves
// canonical function `.name` metadata across esbuild bundling.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import EventEmitter from 'internal/nodelib/events';
import { installEventTargetBridge } from './event_target';

installEventTargetBridge(EventEmitter);

const namedFunctions: ReadonlyArray<readonly [unknown, string]> = [
  [EventEmitter, 'EventEmitter'],
  [EventEmitter.once, 'once'],
  [EventEmitter.on, 'on'],
  [EventEmitter.getEventListeners, 'getEventListeners'],
  [EventEmitter.getMaxListeners, 'getMaxListeners'],
  [EventEmitter.addAbortListener, 'addAbortListener'],
  [EventEmitter.prototype.listenerCount, 'listenerCount'],
];

for (const [fn, expectedName] of namedFunctions) {
  if (typeof fn === 'function' && fn.name !== expectedName) {
    Object.defineProperty(fn, 'name', { value: expectedName, configurable: true });
  }
}

const eearDesc = Object.getOwnPropertyDescriptor(EventEmitter, 'EventEmitterAsyncResource');
if (eearDesc && typeof eearDesc.get === 'function') {
  const originalGet = eearDesc.get;
  const lazyEventEmitterAsyncResource = () => {
    const ctor: unknown = Reflect.apply(originalGet, EventEmitter, []);
    if (typeof ctor === 'function' && ctor.name !== 'EventEmitterAsyncResource') {
      Object.defineProperty(ctor, 'name', {
        value: 'EventEmitterAsyncResource',
        configurable: true,
      });
    }
    return ctor;
  };
  Object.defineProperty(lazyEventEmitterAsyncResource, 'name', {
    value: 'lazyEventEmitterAsyncResource',
    configurable: true,
  });
  Object.defineProperty(EventEmitter, 'EventEmitterAsyncResource', {
    enumerable: eearDesc.enumerable ?? true,
    configurable: eearDesc.configurable ?? true,
    get: lazyEventEmitterAsyncResource,
    set: undefined,
  });
}

export { EventEmitter };
export default EventEmitter;
