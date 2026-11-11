import { Buffer } from 'buffer';
import { Readable } from 'readable-stream/lib/stream.js';
import { type Syscalls, VERSION, fault, record } from './protocol';
import { resourceLimits } from './resource-policy';

export function createStdin(
  sys: Syscalls,
  port: MessagePort,
  retain: () => void,
  release: () => void,
  promptInput = false,
) {
  let held = false;
  let demand = false;
  let paused = false;
  const readBytes = (length: number) => {
    const value = sys.call('stdin.read', [length]);
    if (value !== null && value !== false && !(value instanceof Uint8Array))
      throw fault('EPROTO', 'Invalid input read reply');
    return value;
  };
  const input = Object.assign(
    new Readable({
      highWaterMark: promptInput ? 0 : undefined,
      read() {
        demand = true;
        if (!paused && !held) {
          held = true;
          retain();
        }
        pumpStream();
      },
    }),
    { fd: 0, isTTY: false },
  );
  const done = () => {
    demand = false;
    if (held) {
      held = false;
      release();
    }
  };
  const pumpStream = () => {
    if (!demand || input.destroyed) return;
    // A shell prompt must not prefetch the next command or its child's input.
    // Other guest streams keep normal buffering and paused explicit-pull reads.
    if (promptInput && paused) return;
    try {
      const bytes = readBytes(promptInput ? 1 : 65536);
      if (bytes === false) return;
      demand = false;
      input.push(bytes === null ? null : Buffer.from(bytes));
    } catch (error) {
      input.destroy(error instanceof Error ? error : fault('EIO', String(error)));
    }
  };
  input.on('end', done);
  input.on('pause', () => {
    paused = true;
    // Pause stops flowing delivery and releases the input handle. Readable
    // still owns buffering and explicit pull reads while the stream is paused.
    if (held) {
      held = false;
      release();
    }
  });
  input.on('resume', () => {
    if (input.destroyed || input.readableEnded) return;
    paused = false;
    if (!held) {
      held = true;
      retain();
    }
    demand = true;
    pumpStream();
  });
  input.on('close', () => {
    done();
    sys.call('stdin.close');
  });
  const pending: Array<{
    view: ArrayBufferView;
    bytes: Uint8Array;
    offset: number;
    length: number;
    callback: (error: Error | null, count: number, view: ArrayBufferView) => void;
  }> = [];
  const pump = () => {
    while (pending.length) {
      const request = pending[0];
      if (!request) break;
      let bytes: Uint8Array | null | false;
      let error: Error | null = null;
      try {
        bytes = readBytes(Math.min(request.length, 65536));
      } catch (failure) {
        bytes = null;
        error = failure instanceof Error ? failure : fault('EIO', String(failure));
      }
      if (bytes === false) break;
      pending.shift();
      const count = bytes?.length ?? 0;
      if (bytes) request.bytes.set(bytes, request.offset);
      queueMicrotask(() => {
        try {
          request.callback(error, count, request.view);
        } finally {
          release();
        }
      });
    }
  };
  port.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!record(event.data) || event.data.version !== VERSION || event.data.type !== 'stdin-ready')
      return;
    pump();
    pumpStream();
  });
  port.start();
  return {
    stream: input,
    closeDescriptor() {
      done();
      pump();
    },
    read(buffer: unknown, offset: unknown, length: unknown, position: unknown, callback: unknown) {
      const byteView =
        buffer instanceof Uint8Array
          ? buffer
          : ArrayBuffer.isView(buffer)
            ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
            : null;
      if (
        !ArrayBuffer.isView(buffer) ||
        byteView === null ||
        typeof offset !== 'number' ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        typeof length !== 'number' ||
        !Number.isInteger(length) ||
        length < 0 ||
        offset + length > byteView.byteLength ||
        typeof callback !== 'function'
      )
        throw fault('EINVAL', 'Invalid stdin read arguments');
      if (position !== null && position !== undefined) {
        retain();
        queueMicrotask(() => {
          try {
            const err = Object.assign(new Error('ESPIPE: invalid seek, read'), {
              errno: -29,
              code: 'ESPIPE',
              syscall: 'read',
            });
            callback(err, 0, buffer);
          } finally {
            release();
          }
        });
        return;
      }
      if (pending.length >= resourceLimits().child.pendingStdinReads)
        throw fault('E2BIG', 'Too many pending stdin reads');
      retain();
      pending.push({
        view: buffer,
        bytes: byteView,
        offset,
        length,
        callback: (error, count, view) => callback(error, count, view),
      });
      queueMicrotask(pump);
    },
    receive(bytes: Uint8Array | null) {
      if (bytes === null) {
        sys.call('stdin.write', [null]);
        return;
      }
      if (!bytes.length) sys.call('stdin.write', [bytes]);
      for (let offset = 0; offset < bytes.length; offset += 65536)
        sys.call('stdin.write', [bytes.subarray(offset, offset + 65536)]);
    },
  };
}
