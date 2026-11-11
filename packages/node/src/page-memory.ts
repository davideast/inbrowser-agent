import { VERSION, fault, record } from './protocol';

// A process Worker cannot read the page's heap: `performance.memory` exists only
// on the page, and it is the page isolate's heap, not the Worker's. A query asks
// the host synchronously: the Worker posts a small SharedArrayBuffer and blocks
// in Atomics.wait while the (free) page thread samples `performance.memory` at
// that moment and releases it. The figures are therefore current, page-wide and
// advisory. No kernel round trip is involved; the kernel runs on a Worker too.
//
// Layout: Int32 state at byte 0 (0 pending, 1 sampled, 2 unavailable), then two
// Float64 values at byte 8: used and total heap bytes.
const SIZE = 24;

export interface PageHeap {
  used: number;
  total: number;
}

/** Host side: answers one `page-memory` request. Malformed requests are ignored. */
export function answerPageHeap(shared: unknown): void {
  if (!(shared instanceof SharedArrayBuffer) || shared.byteLength !== SIZE) return;
  const control = new Int32Array(shared, 0, 1);
  const values = new Float64Array(shared, 8, 2);
  const memory: unknown = Reflect.get(performance, 'memory');
  const used = record(memory) ? memory.usedJSHeapSize : undefined;
  const total = record(memory) ? memory.totalJSHeapSize : undefined;
  const valid =
    typeof used === 'number' &&
    typeof total === 'number' &&
    Number.isSafeInteger(used) &&
    Number.isSafeInteger(total) &&
    used >= 0 &&
    used <= total;
  if (valid) {
    values[0] = used;
    values[1] = total;
  }
  Atomics.store(control, 0, valid ? 1 : 2);
  Atomics.notify(control, 0);
}

/**
 * Process side: the host page's current heap figures, or undefined when the page
 * reports no valid measurement. Throws ETIMEDOUT if the host never answers.
 */
export function requestPageHeap(timeoutMs: number): PageHeap | undefined {
  const shared = new SharedArrayBuffer(SIZE);
  const control = new Int32Array(shared, 0, 1);
  const values = new Float64Array(shared, 8, 2);
  self.postMessage({ type: 'page-memory', version: VERSION, shared });
  const deadline = Date.now() + timeoutMs;
  while (Atomics.load(control, 0) === 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw fault('ETIMEDOUT', 'Host page did not answer the memory query');
    Atomics.wait(control, 0, 0, remaining);
  }
  return Atomics.load(control, 0) === 1
    ? { used: values[0] ?? 0, total: values[1] ?? 0 }
    : undefined;
}
