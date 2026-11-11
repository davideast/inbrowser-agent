import { fault, record } from './protocol';

export type OutputPipes = { stdout: SharedArrayBuffer; stderr: SharedArrayBuffer };

export function createOutputPipes(): OutputPipes {
  return { stdout: new SharedArrayBuffer(4), stderr: new SharedArrayBuffer(4) };
}

export function isOutputPipes(value: unknown): value is OutputPipes {
  return (
    record(value) &&
    value.stdout instanceof SharedArrayBuffer &&
    value.stdout.byteLength === 4 &&
    value.stderr instanceof SharedArrayBuffer &&
    value.stderr.byteLength === 4
  );
}

export function closeOutputPipe(buffer: SharedArrayBuffer) {
  Atomics.store(new Int32Array(buffer), 0, 1);
}

export function checkOutputPipe(buffer: SharedArrayBuffer) {
  if (Atomics.load(new Int32Array(buffer), 0) !== 0)
    throw fault('EPIPE', 'Output pipe reader is closed');
}
