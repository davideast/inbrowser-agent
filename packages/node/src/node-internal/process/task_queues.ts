// Browser-safe `internal/process/task_queues` bridge for upstream Node `lib/`.
// Delegates dynamically to `globalThis.queueMicrotask` so experimental
// `asyncContext` mode's wrapped `Microtask` resource is honored automatically.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

export function queueMicrotask(callback: () => void): void {
  globalThis.queueMicrotask(callback);
}
