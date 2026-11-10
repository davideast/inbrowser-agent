import { fault } from './protocol';

function unsupported(): never {
  throw fault(
    'ENOSYS',
    "Async context activation and propagation are unsupported; boot with asyncContext: 'experimental' to enable it",
  );
}

// Node instances start inactive. This runtime supports only that state; methods
// that would establish or capture a context reject before invoking guest code.
export class AsyncLocalStorage {
  // Node 22.18 ignores constructor arguments, so this does too.
  getStore(): undefined {
    return undefined;
  }
  disable(): void {
    // No context can be activated, so there are no owned hooks to release.
  }
  run = unsupported;
  enterWith = unsupported;
  exit = unsupported;
  static bind = unsupported;
  static snapshot = unsupported;
}
