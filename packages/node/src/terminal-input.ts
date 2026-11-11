import { fault } from './protocol';
import { resourceLimits } from './resource-policy';

/** Kernel-owned input discipline shared by inherited terminal descriptors. */
export class TerminalInput {
  private raw = false;
  private line: number[] = [];

  setRaw(mode: unknown): void {
    if (typeof mode !== 'boolean') throw fault('EINVAL', 'Terminal raw mode must be boolean');
    this.raw = mode;
  }

  receive(bytes: Uint8Array, queuedBytes: number): { bytes: Uint8Array; interrupted: boolean } {
    if (this.raw) {
      if (bytes.length + queuedBytes > resourceLimits().child.terminalInputBytes)
        throw fault('E2BIG', 'Guest stdin buffer exceeds limit');
      return { bytes, interrupted: false };
    }
    const line = [...this.line];
    const ready: number[] = [];
    let interrupted = false;
    for (const byte of bytes) {
      if (byte === 3) {
        line.length = 0;
        ready.length = 0;
        interrupted = true;
      } else if (byte === 127) {
        line.pop();
      } else {
        line.push(byte === 13 ? 10 : byte);
        if (line.length > resourceLimits().child.terminalLineBytes)
          throw fault('E2BIG', 'Terminal input line exceeds 64 KiB');
        if (byte === 10 || byte === 13) {
          ready.push(...line);
          line.length = 0;
        }
      }
    }
    if (ready.length + (interrupted ? 0 : queuedBytes) > resourceLimits().child.terminalInputBytes)
      throw fault('E2BIG', 'Guest stdin buffer exceeds limit');
    this.line = line;
    return { bytes: Uint8Array.from(ready), interrupted };
  }
}
