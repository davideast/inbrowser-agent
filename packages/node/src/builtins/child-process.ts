import { type PrepareSyncChild, createChildProcess } from '../child-process';
import type { createFs } from '../fs';
import type { OutputPipes } from '../output-pipe';
import type { Syscalls } from '../protocol';
import { fault, isStdioBindings } from '../value-guards';

export interface ChildProcessBuiltinDeps {
  defaults: () => { cwd: string; env: Record<string, unknown>; execArgv: string[] };
  retain: () => void;
  release: () => void;
  emitOutput: (stream: 'stdout' | 'stderr', bytes: Uint8Array) => void;
  outputPipes: OutputPipes;
  sys: Syscalls;
  fs: ReturnType<typeof createFs>;
  onPrepareSync?: (prepare: PrepareSyncChild) => void;
}

export function createChildProcessBuiltin({
  defaults,
  retain,
  release,
  emitOutput,
  outputPipes,
  sys,
  fs,
  onPrepareSync,
}: ChildProcessBuiltinDeps) {
  return createChildProcess(
    defaults,
    retain,
    release,
    emitOutput,
    outputPipes,
    (stdio) => {
      const bindings = sys.call('stdio.prepare', [stdio]);
      if (!isStdioBindings(bindings)) throw fault('EPROTO', 'Invalid prepared stdio');
      let released = false;
      return {
        bindings,
        release() {
          if (released) return;
          released = true;
          if (!fs.closeSync) throw fault('EPROTO', 'Missing descriptor close');
          // Only aliases the kernel created are owned here; a standard descriptor
          // it left in place names one of this process's own streams.
          for (const [index, fd] of bindings.entries())
            if (typeof fd === 'number' && fd !== stdio[index]) fs.closeSync(fd);
        },
      };
    },
    fs,
    onPrepareSync,
  );
}
