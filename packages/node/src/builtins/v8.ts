import type { EventEmitter } from 'events';
import { type PageHeap, requestPageHeap } from '../page-memory';
import {
  DefaultDeserializer,
  DefaultSerializer,
  Deserializer,
  Serializer,
  deserialize,
  serialize,
} from '../v8-serialize';
import { fault } from '../value-guards';

export interface V8BuiltinDeps {
  advisoryHeapLimit: unknown;
  callTimeoutMs: number;
  samplePageHeap?: (timeoutMs: number) => PageHeap | undefined;
  process?: EventEmitter;
  stream?: unknown;
  fs?: Record<string, unknown>;
  cwd?: () => string;
}

export function createV8Builtin({
  advisoryHeapLimit,
  callTimeoutMs,
  samplePageHeap = requestPageHeap,
}: V8BuiltinDeps) {
  // The pinned Node 22.18 query returns numeric zero during ordinary execution.
  // This runtime does not build Node startup snapshots.
  return {
    Serializer,
    Deserializer,
    DefaultSerializer,
    DefaultDeserializer,
    serialize,
    deserialize,
    startupSnapshot: { isBuildingSnapshot: () => 0 },
    getHeapStatistics: () => {
      const limit = advisoryHeapLimit;
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0)
        throw fault('ENOSYS', 'Browser page advisory heap limit is unavailable');
      // The limit is the approved boot-time advisory. total_heap_size and
      // used_heap_size (v8.md, getHeapStatistics) are the host page's heap sampled
      // now: page-wide, not this Worker's, and omitted when the page reports no
      // valid pair. The remaining eleven documented fields have no browser source
      // and stay absent rather than invented.
      const heap = samplePageHeap(callTimeoutMs);
      return heap
        ? {
            total_heap_size: heap.total,
            used_heap_size: heap.used,
            heap_size_limit: limit,
          }
        : { heap_size_limit: limit };
    },
  };
}
