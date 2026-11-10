import { Buffer } from 'buffer';
import type { createChildProcess } from './child-process';
import type { createFs } from './fs';
import { record } from './protocol';
import { resourceLimits } from './resource-policy';
import { type ShellCommand, ShellError, shellEntry } from './shell';
import { isWasmBinary } from './wasi';

export async function runShell(
  program: ShellCommand[],
  cwd: string,
  environment: Record<string, unknown>,
  fs: ReturnType<typeof createFs>,
  spawn: ReturnType<typeof createChildProcess>['spawn'],
  stderr: (text: string) => void,
): Promise<number> {
  const diagnostic = (error: ShellError, write = stderr) => {
    try {
      write(`sh: ${error.code}: ${error.message}\n`);
      return error.status;
    } catch (writeError) {
      if (!record(writeError) || writeError.code !== 'EPIPE') throw writeError;
      // A failed diagnostic is this stage's SIGPIPE status. The surrounding
      // command list still owns conditional evaluation and the final status.
      return 141;
    }
  };
  let code = 0;
  for (let index = 0; index < program.length; ) {
    const first = program[index++];
    if (!first) break;
    const pipeline = [first];
    while (program[index]?.when === 'pipe') {
      const stage = program[index++];
      if (stage) pipeline.push(stage);
    }
    if (first.when === 'success' && code !== 0) continue;
    if (first.when === 'failure' && code === 0) continue;
    type SpawnedChild = ReturnType<typeof spawn>;
    type StageSlot = {
      child: SpawnedChild | null;
      exited: Promise<number>;
      cleanup: () => void;
      abort?: (error: Error) => void;
      deferredStart?: (inputBytes: Buffer, onSpawned: (child: SpawnedChild) => void) => void;
    };
    const children: StageSlot[] = [];
    try {
      const launchChild = (
        argv: string[],
        env: Record<string, unknown>,
        stdio: Array<string | number>,
        closeFiles: () => void,
      ): { child: SpawnedChild; exited: Promise<number>; cleanup: () => void } => {
        let child: SpawnedChild;
        try {
          child = spawn('node', argv, { cwd, env, stdio });
        } catch (error) {
          closeFiles();
          throw error;
        }
        let finished = false;
        // The host's spawn acknowledgement follows kernel attachment. The
        // child now owns its aliases, so the shell can close its originals.
        child.once('spawn', closeFiles);
        const exited = new Promise<number>((resolve, reject) => {
          child.once('error', (error) => {
            finished = true;
            closeFiles();
            reject(error);
          });
          child.stdin?.once('error', (error) => {
            // A reader may exit before the producer finishes. Its exit status
            // still belongs to this stage; closure is propagated to the writer.
            if (!record(error) || error.code !== 'EPIPE') reject(error);
          });
          child.stdout?.once('error', reject);
          child.once('close', (status: number | null, signal: string | null) => {
            finished = true;
            closeFiles();
            resolve(status ?? (signal === 'SIGINT' ? 130 : signal === 'SIGKILL' ? 137 : 143));
          });
        });
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          closeFiles();
          if (!finished && child.exitCode === null && child.signalCode === null) {
            try {
              child.kill('SIGKILL');
            } catch {
              // Child may already have exited.
            }
          }
        };
        return { child, exited, cleanup };
      };
      for (let stage = 0; stage < pipeline.length; stage++) {
        const command = pipeline[stage]!;
        const env = { ...environment };
        const stdio: Array<string | number> = [
          stage === 0 ? 'inherit' : 'pipe',
          stage === pipeline.length - 1 ? 'inherit' : 'pipe',
          'inherit',
        ];
        const opened: number[] = [];
        const closeFiles = () => {
          if (opened.length === 0) return;
          if (!fs.closeSync) throw new ShellError(1, 'EPROTO', 'Missing filesystem close');
          for (const fd of opened.splice(0)) {
            try {
              fs.closeSync(fd);
            } catch {
              // Descriptor may already be closed.
            }
          }
        };
        const writeDiagnostic = (text: string) => {
          if (typeof stdio[2] !== 'number') stderr(text);
          else {
            if (!fs.writeSync) throw new ShellError(1, 'EPROTO', 'Missing filesystem write');
            fs.writeSync(stdio[2], text);
          }
        };
        let argv: string[];
        try {
          for (const redirect of command.redirects) {
            if (!fs.openSync) throw new ShellError(1, 'EPROTO', 'Missing filesystem open');
            let fd: unknown;
            try {
              fd = fs.openSync(redirect.filename, redirect.flags);
            } catch (error) {
              if (!record(error) || typeof error.code !== 'string') throw error;
              throw new ShellError(1, error.code, String(error.message));
            }
            if (typeof fd !== 'number')
              throw new ShellError(1, 'EPROTO', 'Invalid open descriptor');
            opened.push(fd);
            stdio[redirect.fd] = fd;
          }
          argv = shellEntry(command, cwd, env, fs);
        } catch (error) {
          try {
            if (!(error instanceof ShellError)) throw error;
            children.push({
              child: null,
              exited: Promise.resolve(diagnostic(error, writeDiagnostic)),
              cleanup: closeFiles,
            });
            continue;
          } finally {
            closeFiles();
          }
        }
        // A downstream WASI binary runs `_start` synchronously once its Worker
        // boots, so buffer upstream pipe output (up to pipeBytes) before launching it.
        if (stage > 0 && stdio[0] === 'pipe' && argv[0] && isWasmBinary(fs, argv[0])) {
          let settled = false;
          let resolveExited!: (status: number) => void;
          let rejectExited!: (error: unknown) => void;
          const exited = new Promise<number>((resolve, reject) => {
            resolveExited = resolve;
            rejectExited = reject;
          });
          let launchedSlot: StageSlot | null = null;
          let cleaned = false;
          const slot: StageSlot = {
            child: null,
            exited,
            cleanup() {
              if (cleaned) return;
              cleaned = true;
              closeFiles();
              launchedSlot?.cleanup();
              if (!settled) {
                settled = true;
                resolveExited(1);
              }
            },
            abort(error: Error) {
              closeFiles();
              launchedSlot?.cleanup();
              if (!settled) {
                settled = true;
                rejectExited(error);
              }
            },
            deferredStart(inputBytes, onSpawned) {
              if (cleaned || settled) {
                closeFiles();
                return;
              }
              try {
                const launched = launchChild(argv, env, stdio, closeFiles);
                launchedSlot = launched;
                slot.child = launched.child;
                onSpawned(launched.child);
                for (let off = 0; off < inputBytes.byteLength; off += 65536) {
                  launched.child.stdin?.write(
                    inputBytes.subarray(off, Math.min(off + 65536, inputBytes.byteLength)),
                  );
                }
                launched.child.stdin?.end();
                launched.exited.then(
                  (status) => {
                    if (!settled) {
                      settled = true;
                      resolveExited(status);
                    }
                  },
                  (err) => {
                    if (!settled) {
                      settled = true;
                      rejectExited(err);
                    }
                  },
                );
              } catch (error) {
                closeFiles();
                if (!settled) {
                  settled = true;
                  rejectExited(error);
                }
              }
            },
          };
          children.push(slot);
          continue;
        }
        children.push(launchChild(argv, env, stdio, closeFiles));
      }
      const maxPipeBytes = resourceLimits().child.pipeBytes;
      const wireStageFrom = (stage: number) => {
        const nextSlot = children[stage];
        if (!nextSlot) return;
        const output = children[stage - 1]?.child?.stdout;
        if (nextSlot.deferredStart) {
          const startDeferred = nextSlot.deferredStart;
          const chunks: Buffer[] = [];
          let bufferedBytes = 0;
          let settledStage = false;
          const launch = () => {
            if (settledStage) return;
            settledStage = true;
            startDeferred(Buffer.concat(chunks), () => {
              wireStageFrom(stage + 1);
            });
          };
          if (output) {
            output.on('data', (chunk: Uint8Array) => {
              if (settledStage) return;
              bufferedBytes += chunk.byteLength;
              if (bufferedBytes > maxPipeBytes) {
                settledStage = true;
                chunks.length = 0;
                output.destroy();
                children[stage - 1]?.cleanup();
                nextSlot.abort?.(new ShellError(1, 'E2BIG', 'Pipe buffer limit exceeded'));
                return;
              }
              chunks.push(Buffer.from(chunk));
            });
            output.once('end', launch);
            output.once('close', launch);
          } else {
            launch();
          }
          return;
        }
        const input = nextSlot.child?.stdin;
        if (output && input) {
          input.once('error', () => output.destroy());
          nextSlot.child?.once('close', () => output.destroy());
          output.pipe(input);
        } else if (input) input.end();
        else if (output) output.destroy();
      };
      for (let stage = 1; stage < children.length; stage++) {
        if (children[stage - 1]?.deferredStart) continue;
        wireStageFrom(stage);
      }
      const statuses = await Promise.all(children.map((child) => child.exited));
      code = statuses[statuses.length - 1] ?? 0;
    } catch (error) {
      for (const slot of children) slot.cleanup();
      if (!(error instanceof ShellError)) throw error;
      code = diagnostic(error);
    }
  }
  return code;
}
