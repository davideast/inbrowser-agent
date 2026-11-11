// Browser-safe `async_hooks` bridge for upstream Node `lib/events.js`
// (`lazyEventEmitterAsyncResource`). Exports a live ESM binding for
// `AsyncResource` that resolves to the guest's real `AsyncResource` class in
// experimental `asyncContext` mode and rejects construction with `ENOSYS` in
// default mode.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { type GuestProcessLike, activeProcess, onGuestProcessChange } from './process-ref';

class FallbackAsyncResource {
  constructor() {
    throw Object.assign(
      new Error(
        "EventEmitterAsyncResource requires async hooks; boot with asyncContext: 'experimental' to enable it",
      ),
      { code: 'ENOSYS' },
    );
  }
}

export let AsyncResource: unknown = FallbackAsyncResource;

function syncAsyncResource(proc: GuestProcessLike): void {
  if (typeof proc.getBuiltinModule === 'function') {
    const mod: unknown = proc.getBuiltinModule('async_hooks');
    const candidate: unknown =
      typeof mod === 'object' && mod !== null ? Reflect.get(mod, 'AsyncResource') : undefined;
    AsyncResource = typeof candidate === 'function' ? candidate : FallbackAsyncResource;
  }
}

syncAsyncResource(activeProcess());
onGuestProcessChange(syncAsyncResource);
