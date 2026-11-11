import { installAbortSignalStatics } from '../events-statics';
import { EventEmitter } from '../node-internal/events-entry';
import { setFallbackNextTick } from '../node-internal/process-ref';

export interface EventsBuiltinDeps {
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void;
  setTimeout: Parameters<typeof installAbortSignalStatics>[0];
  createEventEmitterAsyncResource?: (
    base: new (options?: object) => { emit(event: string | symbol, ...args: unknown[]): boolean },
  ) => unknown;
}

export function createEventsBuiltin({ nextTick, setTimeout }: EventsBuiltinDeps) {
  setFallbackNextTick(nextTick);
  installAbortSignalStatics(setTimeout);
  EventEmitter.defaultMaxListeners = 10;
  EventEmitter.captureRejections = false;
  return EventEmitter;
}
