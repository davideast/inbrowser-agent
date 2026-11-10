import { fault } from './protocol';
import { resourceLimits } from './resource-policy';

// Observers are bounded independently of the existing convenience captures.
// Slow/cancelled observers never block or terminate the guest process.
export class OutputChannel {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private open = true;
  readonly stream: ReadableStream<Uint8Array>;
  constructor(limit = resourceLimits().child.outputObserverBytes) {
    this.stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        cancel: () => {
          this.open = false;
        },
      },
      { highWaterMark: limit, size: (bytes) => bytes.byteLength },
    );
  }
  push(bytes: Uint8Array) {
    if (!this.open) return;
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      const part = bytes.subarray(offset, offset + 65536);
      if ((this.controller.desiredSize ?? 0) < part.length) {
        this.open = false;
        this.controller.error(
          fault('E2BIG', 'Output stream observer exceeded 1 MiB; drain it while the process runs'),
        );
        return;
      }
      this.controller.enqueue(part.slice());
    }
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.controller.close();
  }
}
