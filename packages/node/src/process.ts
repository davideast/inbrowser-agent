import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import path from 'path-browserify';
import browserProcess from 'process/browser';
import { createAsyncContext } from './async-context';
import { AsyncLocalStorage } from './async-local-storage';
import { installBufferOutputEncodings } from './buffer-encoding';
import { GuestConsole, writeConsoleAssertion } from './console';
import { createContextCompiler } from './context-compiler';
import { installCapture } from './context-hook';
import { markGuestRealm } from './errors';
import { attachIpc } from './ipc';
import { CAPACITY, SYSCALL_FRAMING_SLACK, Syscalls, VERSION } from './protocol';
import { installResourcePolicy, policyOrDefault, resourceLimits } from './resource-policy';
import { fault, record, unwrap } from './value-guards';
// This module is the process Worker entry: every error it builds may reach guest
// code, which expects Node's plain Error shape. See errors.ts.
markGuestRealm();
import * as url from 'url/';
import { isBuiltin } from './builtin-modules';
import { createAssertBuiltins } from './builtins/assert';
import { createBufferBuiltin } from './builtins/buffer';
import { createChildProcessBuiltin } from './builtins/child-process';
import { createConsoleBuiltin } from './builtins/console-module';
import { createCryptoBuiltin } from './builtins/crypto';
import { createDiagnosticsChannelBuiltin } from './builtins/diagnostics-channel';
import { createDnsBuiltins } from './builtins/dns';
import { createEventsBuiltin } from './builtins/events';
import { registerExtraLibBuiltins } from './builtins/extra-lib';
import { createFsBuiltins } from './builtins/fs';
import { createHttpBuiltins } from './builtins/http';
import { createHttp2Builtin } from './builtins/http2';
import { createNetBuiltin } from './builtins/net';
import { createConstantsBuiltin, createOsBuiltin } from './builtins/os';
import { createPathBuiltins } from './builtins/path';
import { createPerfHooksBuiltin } from './builtins/perf-hooks';
import { createQuerystringBuiltin } from './builtins/querystring';
import { createReadlineBuiltins } from './builtins/readline';
import { createSqliteBuiltin } from './builtins/sqlite';
import { createStreamBuiltins } from './builtins/stream';
import { createStringDecoderBuiltin } from './builtins/string-decoder';
import { registerTestRunnerBuiltins } from './builtins/test-runner';
import { createTimersBuiltins } from './builtins/timers';
import { createTlsBuiltin } from './builtins/tls';
import { createTtyBuiltin } from './builtins/tty';
import { createUtilBuiltins } from './builtins/util';
import { createV8Builtin } from './builtins/v8';
import { createWasiBuiltin } from './builtins/wasi';
import { createWorkerThreadsBuiltin } from './builtins/worker-threads';
import { createZlibBuiltin } from './builtins/zlib';
import { type PrepareSyncChild, installSyncWaitHelper } from './child-process';
import { initializeCryptoComparison } from './crypto-compare';
import { installSubtleCryptoKeyCapture } from './crypto-keys';
import { parseEnv } from './env-file';
import { nodeOptionsRejectionMode, parseExecArgv, warningFlags } from './exec-argv';
import { fileURLToPath, pathToFileURL } from './file-url';
import { createFs } from './fs';
import { createInspector } from './inspector';
import { runInteractiveShell } from './interactive-shell';
import { createLoader } from './loader';
import { retainNativeReads } from './native-read-retention';
import { checkOutputPipe, isOutputPipes } from './output-pipe';
import { requestPageHeap } from './page-memory';
import { createFinalization } from './process-finalization';
import { type ExceptionOrigin, createLifecycle, printable } from './process-lifecycle';
import { allowedFlags, buildConfig, installIdentity, release } from './process-metadata';
import { createReport } from './process-report';
import { createWarnings, invalidArgType } from './process-warning';
import { ShellError, parseShell, shellEntry } from './shell';
import { runShell } from './shell-runner';
import { createStdin } from './stdin';
import { type TerminalDimensions, terminalDimensions } from './terminal';
import { installUncaughtOffer } from './uncaught-hook';
import { domainToASCII, domainToUnicode } from './url-domain';
import { urlToHttpOptions } from './url-http-options';
import { formatWithOptions } from './util-format';
import { setLoweredFunctionKind } from './util-inspect';
import { kCustomPromisifiedSymbol } from './util-promisify';
import { createWasiClass, isWasmBinary } from './wasi';

installBufferOutputEncodings();

// Preserve host timers before the loader installs guest globals in this realm.
const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
const hostQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
const HostWorker = globalThis.Worker;
// Saved before guest code runs: guests may replace these built-ins.
const savedFunctionToString = Function.prototype.toString;
const savedGetPrototypeOf = Reflect.getPrototypeOf;
// This bundle is not compiled, so these are the engine's own prototypes.
const asyncFunctionPrototype = Reflect.getPrototypeOf(async () => {});
const asyncGeneratorFunctionPrototype = Reflect.getPrototypeOf(async function* () {});
const shimNextTick = browserProcess.nextTick.bind(browserProcess);

// process.hrtime has no syscall: it derives a monotonic nanosecond count from
// the browser's own performance clock rather than a host time source. Browser
// engines coarsen performance.now() for fingerprinting resistance, so this
// does not provide native nanosecond resolution; only monotonicity within a
// process, and consistency between the tuple and bigint forms, are promised.
const hrtimeNs = (): bigint => {
  const millisecondsSinceEpoch = performance.timeOrigin + performance.now();
  return BigInt(Math.round(millisecondsSinceEpoch * 1_000_000));
};
/** Node's process.ref/unref: the refable protocol symbol first, then the method. */
const refable = (value: unknown, method: 'ref' | 'unref'): void => {
  if (value === null || value === undefined) return;
  const target = Object(value);
  const fn: unknown =
    Reflect.get(target, Symbol.for(`nodejs.${method}`), value) ||
    Reflect.get(target, method, value);
  if (typeof fn === 'function') Reflect.apply(fn, value, []);
};
const hrtimeTuple = (nanoseconds: bigint): [number, number] => {
  const seconds = nanoseconds / 1_000_000_000n;
  const remainder = nanoseconds % 1_000_000_000n;
  return [Number(seconds), Number(remainder)];
};

const WASM_STDIN_CTRL_EPOCH = 0;
const WASM_STDIN_CTRL_PKT_STATE = 1;
const WASM_STDIN_CTRL_PKT_LEN = 2;
const WASM_STDIN_CTRL_KERNEL_READY = 3;

const WASM_STDIN_PKT_EMPTY = 0;
const WASM_STDIN_PKT_DATA = 1;
const WASM_STDIN_PKT_EOF = 2;

self.onmessage = async (event: MessageEvent<unknown>) => {
  const boot = event.data;
  if (record(boot) && boot.type === 'sync-wait-helper' && boot.version === VERSION) {
    installSyncWaitHelper();
    self.postMessage({ type: 'sync-wait-ready', version: VERSION });
    return;
  }
  if (record(boot) && boot.type === 'wasm-stdin-runner') {
    const closeTransferredPorts = () => {
      for (const p of event.ports) {
        try {
          p.close();
        } catch {
          // Port may already be closed.
        }
      }
      if (boot.port instanceof MessagePort) {
        try {
          boot.port.close();
        } catch {
          // Port may already be closed.
        }
      }
    };
    if (
      boot.version !== VERSION ||
      !(boot.port instanceof MessagePort) ||
      !(boot.shared instanceof SharedArrayBuffer) ||
      !(boot.stdinSab instanceof SharedArrayBuffer) ||
      boot.stdinSab.byteLength < 64 + 1024 ||
      !(boot.wasmBuffer instanceof ArrayBuffer) ||
      !Array.isArray(boot.argv) ||
      Array.from(boot.argv).some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
      !record(boot.env) ||
      typeof boot.cwd !== 'string' ||
      !isOutputPipes(boot.outputPipes) ||
      !Array.isArray(boot.fileStdio) ||
      boot.fileStdio.length > 3 ||
      Array.from(boot.fileStdio).some((fd) => fd !== 0 && fd !== 1 && fd !== 2)
    ) {
      closeTransferredPorts();
      self.close();
      return;
    }
    installResourcePolicy(policyOrDefault(boot.resources));
    const runnerLimits = resourceLimits();
    const runnerMaxSyscallBytes =
      Math.max(
        CAPACITY,
        runnerLimits.filesystem.descriptorReadBytes,
        runnerLimits.filesystem.descriptorWriteBytes,
        runnerLimits.filesystem.fileReadBytes,
      ) + SYSCALL_FRAMING_SLACK;
    const runnerSys = new Syscalls(
      boot.port,
      boot.shared,
      runnerLimits.syscall.callTimeoutMs,
      runnerMaxSyscallBytes,
    );
    const runnerCwd = boot.cwd;
    const runnerOutputPipes = boot.outputPipes;
    const runnerFileStdio = boot.fileStdio;
    const runnerClosedStdio = new Set<number>();
    const runnerFs = createFs(
      runnerSys,
      () => runnerCwd,
      runnerLimits.filesystem.descriptorReadBytes,
      () => {},
      {
        writeOutput: (stream, bytes) => {
          checkOutputPipe(runnerOutputPipes[stream]);
          if (bytes.byteLength > 0) {
            self.postMessage({
              type: 'wasm-output',
              version: VERSION,
              stream,
              bytes: bytes.slice(),
            });
          }
        },
        onCloseFd: (fd) => {
          if (fd === 0 || fd === 1 || fd === 2) runnerClosedStdio.add(fd);
        },
      },
    );
    const stdinCtrl = new Int32Array(boot.stdinSab, 0, 16);
    const stdinPayload = new Uint8Array(boot.stdinSab, 64);
    let pendingChunk: Uint8Array | null = null;
    let pendingOffset = 0;
    let stdinAtEof = false;
    let kernelEof = false;
    const takeFromChunk = (target: Uint8Array, chunk: Uint8Array): number => {
      const take = Math.min(target.byteLength, chunk.byteLength);
      target.set(chunk.subarray(0, take), 0);
      if (take < chunk.byteLength) {
        pendingChunk = chunk;
        pendingOffset = take;
      }
      return take;
    };
    const readStdin = (target: Uint8Array, allowBlock: boolean): number => {
      if (runnerClosedStdio.has(0)) {
        throw Object.assign(new Error('EBADF: bad file descriptor, read'), { code: 'EBADF' });
      }
      if (target.byteLength === 0) return 0;
      if (pendingChunk !== null && pendingOffset < pendingChunk.byteLength) {
        const take = Math.min(target.byteLength, pendingChunk.byteLength - pendingOffset);
        target.set(pendingChunk.subarray(pendingOffset, pendingOffset + take), 0);
        pendingOffset += take;
        if (pendingOffset >= pendingChunk.byteLength) {
          pendingChunk = null;
          pendingOffset = 0;
        }
        return take;
      }
      if (stdinAtEof) return 0;
      for (;;) {
        const seenEpoch = Atomics.load(stdinCtrl, WASM_STDIN_CTRL_EPOCH);
        if (!kernelEof && Atomics.exchange(stdinCtrl, WASM_STDIN_CTRL_KERNEL_READY, 0) === 1) {
          const kbytes = runnerSys.call('stdin.read', [Math.min(target.byteLength, 65536)]);
          if (kbytes === null) {
            kernelEof = true;
          } else if (kbytes instanceof Uint8Array) {
            if (kbytes.byteLength > 0) {
              Atomics.store(stdinCtrl, WASM_STDIN_CTRL_KERNEL_READY, 1);
              return takeFromChunk(target, kbytes);
            }
          } else if (kbytes !== false) {
            throw fault('EPROTO', 'Invalid input read reply');
          }
        }
        const pktState = Atomics.load(stdinCtrl, WASM_STDIN_CTRL_PKT_STATE);
        if (pktState === WASM_STDIN_PKT_DATA) {
          const len = Atomics.load(stdinCtrl, WASM_STDIN_CTRL_PKT_LEN);
          if (len < 0 || len > stdinPayload.byteLength) {
            throw fault('EPROTO', 'Invalid wasm stdin packet length');
          }
          const chunk = stdinPayload.slice(0, len);
          Atomics.store(stdinCtrl, WASM_STDIN_CTRL_PKT_STATE, WASM_STDIN_PKT_EMPTY);
          self.postMessage({ type: 'wasm-stdin-consumed', version: VERSION });
          if (len === 0) continue;
          return takeFromChunk(target, chunk);
        }
        if (pktState === WASM_STDIN_PKT_EOF) {
          stdinAtEof = true;
          return 0;
        }
        if (pktState !== WASM_STDIN_PKT_EMPTY) {
          throw fault('EPROTO', 'Invalid wasm stdin packet state');
        }
        if (kernelEof) {
          stdinAtEof = true;
          return 0;
        }
        if (!allowBlock) return 0;
        Atomics.wait(stdinCtrl, WASM_STDIN_CTRL_EPOCH, seenEpoch);
      }
    };
    try {
      const wasiEnv: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(boot.env)) {
        if (value !== undefined) wasiEnv[key] = String(value);
      }
      const WASI = createWasiClass({
        fs: runnerFs,
        sys: runnerSys,
        cwd: () => runnerCwd,
        hrtimeNs,
        readStdin,
        exit: (code) => {
          self.postMessage({ type: 'wasm-exit', version: VERSION, code });
          const parked = new Int32Array(new SharedArrayBuffer(4));
          for (;;) Atomics.wait(parked, 0, 0);
        },
      });
      const wasi = new WASI({
        version: 'preview1',
        args: Array.from(boot.argv, (arg) => String(arg)),
        env: wasiEnv,
        preopens: { '/': '/', '.': runnerCwd },
        stdin: 0,
        stdout: 1,
        stderr: 2,
        returnOnExit: true,
      });
      const wasmModule = new WebAssembly.Module(boot.wasmBuffer);
      const wasmInstance = new WebAssembly.Instance(wasmModule, wasi.getImportObject());
      const code = wasi.start(wasmInstance);
      self.postMessage({ type: 'wasm-exit', version: VERSION, code });
    } catch (error) {
      const text = error instanceof Error ? (error.stack ?? error.message) : printable(error);
      const errBytes = Buffer.from(text.endsWith('\n') ? text : `${text}\n`);
      try {
        if (runnerFileStdio.includes(2)) {
          runnerFs.writeSync?.(2, errBytes);
        } else if (!runnerClosedStdio.has(2)) {
          checkOutputPipe(runnerOutputPipes.stderr);
          self.postMessage({
            type: 'wasm-output',
            version: VERSION,
            stream: 'stderr',
            bytes: errBytes,
          });
        }
      } catch {
        // Ignore closed or broken diagnostic stream during failure reporting.
      }
      self.postMessage({ type: 'wasm-exit', version: VERSION, code: 1 });
    }
    return;
  }
  if (record(boot) && boot.type === 'boot' && boot.version !== VERSION) {
    self.postMessage({
      type: 'output',
      stream: 'stderr',
      bytes: new TextEncoder().encode('EPROTO: Incompatible process bootstrap version\n'),
    });
    self.postMessage({ type: 'exit', code: 1 });
    self.close();
    return;
  }
  if (
    !record(boot) ||
    boot.type !== 'boot' ||
    typeof boot.pid !== 'number' ||
    !Number.isSafeInteger(boot.pid) ||
    boot.pid < 1 ||
    (boot.thread !== undefined &&
      (!record(boot.thread) ||
        !(boot.thread.port instanceof MessagePort) ||
        typeof boot.thread.processId !== 'number' ||
        !Number.isSafeInteger(boot.thread.processId) ||
        boot.thread.processId < 1)) ||
    (boot.httpAgentMode !== 'socket' && boot.httpAgentMode !== 'fetch') ||
    (boot.command !== 'node' && boot.command !== 'sh') ||
    !(boot.port instanceof MessagePort) ||
    (boot.ipcPort !== undefined && !(boot.ipcPort instanceof MessagePort)) ||
    (boot.ipcSerialization !== undefined &&
      boot.ipcSerialization !== 'json' &&
      boot.ipcSerialization !== 'advanced') ||
    !(boot.shared instanceof SharedArrayBuffer) ||
    !Array.isArray(boot.argv) ||
    typeof boot.argv[0] !== 'string' ||
    Array.from(boot.argv).some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    typeof boot.moduleBase !== 'string' ||
    !record(boot.options) ||
    !isOutputPipes(boot.outputPipes) ||
    !Array.isArray(boot.fileStdio) ||
    boot.fileStdio.length > 3 ||
    Array.from(boot.fileStdio).some((fd) => fd !== 0 && fd !== 1 && fd !== 2)
  )
    return;
  if (boot.asyncContext !== undefined && boot.asyncContext !== 'experimental') return;
  // The host's resolved policy arrives with the boot message, before the guest
  // realm exists, so every bound in this Worker reads from it.
  installResourcePolicy(policyOrDefault(boot.resources));
  const limits = resourceLimits();
  const asyncContext = boot.asyncContext === 'experimental' ? createAsyncContext() : undefined;
  if (asyncContext) installCapture(asyncContext.capture);
  const maxSyscallBytes =
    Math.max(
      CAPACITY,
      limits.filesystem.descriptorReadBytes,
      limits.filesystem.descriptorWriteBytes,
      limits.filesystem.fileReadBytes,
    ) + SYSCALL_FRAMING_SLACK;
  const sys = new Syscalls(boot.port, boot.shared, limits.syscall.callTimeoutMs, maxSyscallBytes);
  let cwd = typeof boot.options.cwd === 'string' ? boot.options.cwd : '/';
  const outputPipes = boot.outputPipes;
  const fileStdio = boot.fileStdio;
  const closedStdio = new Set<number>();
  // Counted so a forked child's IPC messages can be ordered after its output.
  let emittedOutputs = 0;
  const emitOutput = (name: 'stdout' | 'stderr', value: unknown) => {
    const bytes = value instanceof Uint8Array ? value : Buffer.from(String(value));
    emittedOutputs++;
    self.postMessage({ type: 'output', stream: name, bytes });
    return true;
  };
  const fs = createFs(
    sys,
    () => cwd,
    limits.filesystem.descriptorReadBytes,
    // A callback operation is loop work to `beforeExit`, though it settles in a microtask.
    () => lifecycle.worked(),
    {
      writeOutput: (stream, bytes) => {
        checkOutputPipe(outputPipes[stream]);
        if (bytes.byteLength > 0) emitOutput(stream, bytes);
      },
      onCloseFd: (fd) => {
        if (fd === 0 || fd === 1 || fd === 2) closedStdio.add(fd);
        if (fd === 0) input.closeDescriptor();
      },
    },
  );
  const output = (name: 'stdout' | 'stderr', value: unknown) => {
    const fd = name === 'stdout' ? 1 : 2;
    if (fileStdio.includes(fd)) {
      const bytes = value instanceof Uint8Array ? value : Buffer.from(String(value));
      if (!fs.writeSync) throw fault('EPROTO', 'Missing filesystem write');
      fs.writeSync(fd, bytes);
      return true;
    }
    if (closedStdio.has(fd))
      throw Object.assign(new Error('EBADF: bad file descriptor, write'), {
        errno: -9,
        code: 'EBADF',
        syscall: 'write',
      });
    checkOutputPipe(outputPipes[name]);
    return emitOutput(name, value);
  };
  let prepareSyncChild: PrepareSyncChild | undefined;
  // Reports the status and stops this thread where it stands. Node runs nothing
  // after an exit, not even a pending reaction or a `finally` around
  // process.exit(); the host terminates the Worker when it receives the message.
  const terminate = (code: number, signal?: 'SIGABRT'): never => {
    self.postMessage(signal ? { type: 'exit', code, signal } : { type: 'exit', code });
    const parked = new Int32Array(new SharedArrayBuffer(4));
    for (;;) Atomics.wait(parked, 0, 0);
  };
  const report = (error: unknown) => {
    if (boot.thread)
      self.postMessage({
        type: 'thread-error',
        version: VERSION,
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : printable(error),
      });
    else {
      try {
        output('stderr', error instanceof Error ? error.stack : printable(error));
      } catch (writeError) {
        // Node failure termination must complete even when its diagnostic
        // stream no longer has a reader.
        if (
          !record(writeError) ||
          (writeError.code !== 'EPIPE' &&
            !(writeError.code === 'EBADF' && (fileStdio.includes(2) || closedStdio.has(2))))
        )
          throw writeError;
      }
    }
  };
  // A failure before the guest `process` exists has no listeners to consult.
  const fail = (error: unknown) => {
    report(error);
    self.postMessage({ type: 'exit', code: 1 });
    self.close();
  };
  let uncaught: (error: unknown, origin: ExceptionOrigin) => void = fail;
  let rejected: (reason: unknown, promise: object) => void = fail;
  let rejectionHandled: (promise: object) => void = () => {};
  self.addEventListener('error', (event: ErrorEvent) => {
    event.preventDefault();
    // Guest errors must use this process's stderr binding, including file
    // redirection. The event carries the thrown value; only a thrown null or
    // undefined is indistinguishable from an event without one, so those two
    // are recovered from the engine's message.
    const thrown: unknown = event.error;
    uncaught(
      thrown ??
        (event.message === 'Uncaught null'
          ? null
          : event.message === 'Uncaught undefined'
            ? undefined
            : event.message),
      'uncaughtException',
    );
  });
  self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    event.preventDefault();
    rejected(event.reason, event.promise);
  });
  self.addEventListener('rejectionhandled', (event: PromiseRejectionEvent) => {
    rejectionHandled(event.promise);
  });
  let terminal: TerminalDimensions | undefined;
  let terminalFds: boolean[] = [false, false, false];
  try {
    terminal =
      boot.options.terminal === undefined ? undefined : terminalDimensions(boot.options.terminal);
    if (
      boot.terminalFds !== undefined &&
      (!Array.isArray(boot.terminalFds) ||
        boot.terminalFds.length !== 3 ||
        Array.from(boot.terminalFds).some((value) => typeof value !== 'boolean'))
    )
      throw fault('EPROTO', 'Invalid terminal descriptor mask');
    terminalFds = terminal ? (boot.terminalFds ?? [true, true, true]) : [false, false, false];
  } catch (error) {
    fail(error);
    return;
  }
  const outputStream = (name: 'stdout' | 'stderr') => {
    const events = new EventEmitter();
    let errorEmitted = false;
    const tty = terminalFds[name === 'stdout' ? 1 : 2] === true;
    return Object.assign(events, {
      fd: name === 'stdout' ? 1 : 2,
      writable: true,
      isTTY: tty,
      columns: tty ? terminal?.columns : undefined,
      rows: tty ? terminal?.rows : undefined,
      write: (value: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
        const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        try {
          const result = output(name, value);
          if (typeof done === 'function') queueMicrotask(() => done());
          return result;
        } catch (error) {
          const fd = name === 'stdout' ? 1 : 2;
          if (
            !record(error) ||
            (error.code !== 'EPIPE' &&
              !(error.code === 'EBADF' && (fileStdio.includes(fd) || closedStdio.has(fd))))
          )
            throw error;
          queueMicrotask(() => {
            if (typeof done === 'function') done(error);
            if (!errorEmitted) {
              errorEmitted = true;
              events.emit('error', error);
            }
          });
          return false;
        }
      },
    });
  };
  const input = createStdin(
    sys,
    boot.port,
    () => retainHandle(),
    () => releaseHandle(),
    boot.command === 'sh' && boot.argv.length === 1 && boot.argv[0] === '-i',
  );
  const fileRead = fs.read;
  input.stream.isTTY = terminalFds[0] === true;
  if (input.stream.isTTY) {
    Object.assign(input.stream, {
      isRaw: false,
      setRawMode(mode: boolean) {
        if (typeof mode !== 'boolean') throw fault('EINVAL', 'Raw mode requires a boolean');
        // Native TTY streams update their flag without an ioctl once the
        // destroyed stream no longer owns an input handle.
        if (!input.stream.destroyed) sys.call('stdin.rawMode', [mode]);
        Object.assign(input.stream, { isRaw: mode });
        return input.stream;
      },
    });
  }
  if (typeof fileRead !== 'function') throw fault('EPROTO', 'Missing filesystem read operation');
  fs.read = (fd, ...args) =>
    fd === 0 && !fileStdio.includes(0) && !closedStdio.has(0)
      ? input.read(args[0], args[1], args[2], args[3], args[4])
      : fileRead(fd, ...args);
  let startup: ReturnType<typeof parseExecArgv>;
  try {
    startup = parseExecArgv(boot.execArgv);
  } catch (error) {
    fail(error);
    return;
  }
  // os.md "os.freemem()" has no unavailable value and no browser API reports
  // free system memory. The advisory is totalmem() minus the host page's
  // current used heap, clamped to [0, totalmem]: an upper-bound estimate that
  // ignores every other consumer. Either missing source fails explicitly.
  const advisoryFreeMemory = () => {
    const gib: unknown = Reflect.get(navigator, 'deviceMemory');
    if (typeof gib !== 'number' || !Number.isFinite(gib) || gib <= 0)
      throw fault('ENOSYS', 'Browser device memory is unavailable');
    const heap = requestPageHeap(limits.syscall.callTimeoutMs);
    if (!heap) throw fault('ENOSYS', 'Browser page heap measurement is unavailable');
    const total = Math.round(gib * 1024 ** 3);
    return Math.min(total, Math.max(0, Math.trunc(total - heap.used)));
  };
  const process = Object.assign(new EventEmitter(), {
    argv: ['/bin/node', ...boot.argv],
    // Metadata is mutable without changing the already parsed startup behavior.
    execArgv: [...startup.argv],
    execPath: '/bin/node',
    env: { ...(record(boot.options.env) ? boot.options.env : {}) },
    pid:
      record(boot.thread) && typeof boot.thread.processId === 'number'
        ? boot.thread.processId
        : boot.pid,
    platform: 'browser',
    // Runtime identity, like platform: a browser Worker is not a compiled Node
    // binary and Node's documented architecture list (process.md, process.arch)
    // has no value for it. No host CPU architecture is probed or invented.
    arch: 'browser',
    // process.md "process.features.*" (1945-2084): each member says whether the
    // Node.js build has a capability. This runtime has none of them: no inspector
    // (inspector.url() is undefined), no libuv, no TLS or IPv6 sockets, no
    // require() of ES modules, no builtin code cache, no debug build. The two
    // deprecated members documented as "always true" (uv, ipv6) describe real
    // builds. typescript is the documented false of --no-experimental-strip-types
    // (2060-2072): this runtime never strips or transforms TypeScript.
    features: {
      inspector: false,
      debug: false,
      uv: false,
      ipv6: false,
      tls_alpn: false,
      tls_sni: false,
      tls_ocsp: false,
      tls: false,
      openssl_is_boringssl: false,
      cached_builtins: false,
      require_module: false,
      typescript: false,
    },
    version: 'v22.18.0',
    versions: { node: '22.18.0' },
    // process.md "process.memoryUsage()" (2807-2862) requires five integers and
    // defines no unavailable value. No browser API reports a process resident set
    // size, so these are ADVISORY page-wide figures built only from the host
    // page's current performance.memory (see page-memory.ts), sampled on each
    // call: heapTotal and heapUsed are totalJSHeapSize and usedJSHeapSize; rss is
    // a documented lower bound equal to heapTotal; external and arrayBuffers are
    // 0, meaning "not measured". Without a valid page measurement both forms
    // throw ENOSYS rather than substituting constants.
    memoryUsage: (() => {
      const sample = () => {
        const heap = requestPageHeap(limits.syscall.callTimeoutMs);
        if (!heap) throw fault('ENOSYS', 'Browser page heap measurement is unavailable');
        return heap;
      };
      return Object.assign(
        () => {
          const heap = sample();
          return {
            rss: heap.total,
            heapTotal: heap.total,
            heapUsed: heap.used,
            external: 0,
            arrayBuffers: 0,
          };
        },
        { rss: () => sample().total },
      );
    })(),
    // process.md "process.constrainedMemory()": 0 when "there is no such
    // constraint, or the constraint is unknown". No OS-imposed limit is known here.
    constrainedMemory: () => 0,
    // uv_get_available_memory: with no known constraint it is "identical to
    // uv_get_free_memory()", so this is os.freemem()'s advisory and fails as it does.
    availableMemory: () => advisoryFreeMemory(),
    // process.md "process.resourceUsage()": every field maps to getrusage, with no
    // documented unavailable value for CPU time, maxRSS, page faults, block I/O or
    // context switches, and no browser API reports any of them. Elapsed time is
    // not CPU time, so nothing is substituted.
    resourceUsage: () => {
      throw fault('ENOSYS', 'process.resourceUsage has no browser source');
    },
    hrtime: Object.assign(
      (previous?: unknown): [number, number] => {
        const now = hrtimeNs();
        if (previous === undefined) return hrtimeTuple(now);
        if (!Array.isArray(previous))
          throw Object.assign(
            new TypeError(
              `The "time" argument must be an instance of Array. Received ${
                previous === null ? 'null' : typeof previous
              }`,
            ),
            { code: 'ERR_INVALID_ARG_TYPE' },
          );
        if (previous.length !== 2)
          throw Object.assign(
            new RangeError(
              `The value of "time" is out of range. It must be 2. Received ${previous.length}`,
            ),
            { code: 'ERR_OUT_OF_RANGE' },
          );
        const previousNs =
          BigInt(Math.trunc(Number(previous[0]))) * 1_000_000_000n +
          BigInt(Math.trunc(Number(previous[1])));
        return hrtimeTuple(now - previousNs);
      },
      { bigint: (): bigint => hrtimeNs() },
    ),
    umask: (mask?: unknown) => {
      if (mask !== undefined)
        throw fault('ENOSYS', 'Changing the virtual creation mask is unsupported');
      // The canonical virtual filesystem applies creation modes without a mask.
      return 0;
    },
    cwd: () => cwd,
    chdir: (value: string) => {
      const next = path.resolve(cwd, value);
      const stat = fs.statSync(next);
      if (!record(stat) || typeof stat.isDirectory !== 'function' || !stat.isDirectory())
        throw fault('ENOTDIR', next);
      cwd = next;
    },
    // Node begins unset; guest assignment can subsequently supply a numeric status.
    exitCode: undefined as number | undefined,
    stdin: input.stream,
    stdout: outputStream('stdout'),
    stderr: outputStream('stderr'),
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
      // Node drops ticks scheduled once `exit` has been emitted.
      if (process._exiting) return;
      if (!asyncContext) {
        queueMicrotask(() => fn(...args));
        return;
      }
      // Node's tick is a TickObject resource, announced when it is scheduled.
      const tick = asyncContext.once(fn, 'TickObject');
      hostQueueMicrotask(() => {
        tick(...args);
      });
    },
    // True from the moment `exit` is emitted, as in Node.
    _exiting: false,
    exit: (...args: [code?: number]): never => lifecycle.exit(args),
    setUncaughtExceptionCaptureCallback: (fn: unknown) =>
      lifecycle.setUncaughtExceptionCaptureCallback(fn),
    hasUncaughtExceptionCaptureCallback: () => lifecycle.hasUncaughtExceptionCaptureCallback(),
  });
  // The bundled stream implementation identifies stdio through its browser
  // process shim so pipe() leaves these process-owned outputs open at EOF.
  Object.assign(browserProcess, { stdout: process.stdout, stderr: process.stderr });
  // The same formatter as util.format, so console output describes values as
  // util.inspect does.
  const formatConsole = (...args: unknown[]) => formatWithOptions({}, ...args);
  const consoleOutput = (name: 'stdout' | 'stderr', text: string) => {
    try {
      output(name, text);
    } catch (error) {
      if (!record(error) || error.code !== 'EPIPE') throw error;
    }
  };
  const consoleMethods = new GuestConsole(process.stdout, process.stderr);
  const unsupportedConsoleDiagnostic = () => {
    throw fault('ENOSYS', 'Console timers, counters and traces are not implemented');
  };
  const guestConsole = {
    assert: (condition?: unknown, ...args: unknown[]): void =>
      writeConsoleAssertion(condition, args, (...values) => guestConsole.warn(...values)),
    dir: consoleMethods.dir,
    time: unsupportedConsoleDiagnostic,
    timeEnd: unsupportedConsoleDiagnostic,
    timeLog: unsupportedConsoleDiagnostic,
    count: unsupportedConsoleDiagnostic,
    trace: unsupportedConsoleDiagnostic,
    Console: GuestConsole,
    log: (...args: unknown[]) => consoleOutput('stdout', formatConsole(...args) + '\n'),
    error: (...args: unknown[]) => consoleOutput('stderr', formatConsole(...args) + '\n'),
    warn: (...args: unknown[]) => consoleOutput('stderr', formatConsole(...args) + '\n'),
  };
  let active = 0;
  let evaluating = true;
  const timers = new Map<number, GuestTimeout>();
  const parkedUnrefTimers = new Map<number, GuestTimeout>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const isAlive = () => active > 0 || Array.from(timers.values()).some((timer) => timer.hasRef());
  const cancelIdleTimer = () => {
    if (idleTimer === undefined) return;
    hostClearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const flushParkedTimers = () => {
    if (parkedUnrefTimers.size === 0 || lifecycle.finishing()) return;
    const pending = Array.from(parkedUnrefTimers.values());
    parkedUnrefTimers.clear();
    for (const timer of pending) timer.resumeParked();
  };
  const dropParkedTimers = () => {
    for (const timer of parkedUnrefTimers.values()) timer.dropParked();
    parkedUnrefTimers.clear();
  };
  const idle = () => {
    if (isAlive()) {
      cancelIdleTimer();
      return;
    }
    if (idleTimer !== undefined) return;
    // Browser unhandled-rejection reporting is a queued task. Keep an armed
    // two-turn window intact so unreferenced timer churn cannot starve drain,
    // while starting a fresh two-turn window on every alive -> idle transition.
    idleTimer = hostSetTimeout(() => {
      if (isAlive()) {
        idleTimer = undefined;
        return;
      }
      idleTimer = hostSetTimeout(() => {
        idleTimer = undefined;
        lifecycle.drain();
      }, 0);
    }, 0);
  };
  let aliveCheckQueued = false;
  const scheduleAliveCheck = () => {
    if (aliveCheckQueued) return;
    aliveCheckQueued = true;
    hostQueueMicrotask(() => {
      aliveCheckQueued = false;
      if (isAlive()) {
        cancelIdleTimer();
        lifecycle.worked();
      }
    });
  };
  const retainHandle = () => {
    active++;
    scheduleAliveCheck();
  };
  const releaseHandle = () => {
    active--;
    idle();
  };
  const holdHandle = () => {
    retainHandle();
    return releaseHandle;
  };
  const diagnostic = (text: string) => {
    try {
      output('stderr', text);
    } catch (writeError) {
      if (
        !record(writeError) ||
        (writeError.code !== 'EPIPE' &&
          !(writeError.code === 'EBADF' && (fileStdio.includes(2) || closedStdio.has(2))))
      )
        throw writeError;
    }
  };
  // Node sets each of these only when its flag is given; guests may assign them.
  const warningFlag = warningFlags(startup.argv);
  if (warningFlag.noDeprecation) Object.assign(process, { noDeprecation: true });
  if (warningFlag.throwDeprecation) Object.assign(process, { throwDeprecation: true });
  if (warningFlag.traceDeprecation) Object.assign(process, { traceDeprecation: true });
  if (warningFlag.traceWarnings) Object.assign(process, { traceProcessWarnings: true });
  // Installed before any other listener: the reporter is the first `warning` listener.
  const warnings = createWarnings({
    process,
    print: !warningFlag.noWarnings && process.env.NODE_NO_WARNINGS !== '1',
    diagnostic,
  });
  Object.assign(process, {
    emitWarning: warnings.emitWarning,
    finalization: createFinalization(process),
    release,
    config: buildConfig(),
    // NODE_OPTIONS is read for this flag only (nodeOptionsRejectionMode).
    allowedNodeEnvironmentFlags: allowedFlags(['--unhandled-rejections']),
    // No Node internal binding or builtin module source is loaded in this runtime.
    moduleLoadList: [],
    // No `domain` module exists here, so no domain is ever active.
    domain: null,
    // Node's per_thread.js: the refable protocol symbol first, then ref()/unref().
    ref: (maybeRefable: unknown) => refable(maybeRefable, 'ref'),
    unref: (maybeRefable: unknown) => refable(maybeRefable, 'unref'),
    // Ends the process at once by SIGABRT (status 134): no `exit` listener runs.
    // No core file or native stack exists to write in a browser Worker.
    abort: (): never => {
      if (boot.thread)
        throw Object.assign(new TypeError('process.abort() is not supported in workers'), {
          code: 'ERR_WORKER_UNSUPPORTED_OPERATION',
        });
      return terminate(134, 'SIGABRT');
    },
    loadEnvFile: (path: unknown = undefined) => {
      let target = './.env';
      if (path != null) {
        if (path instanceof URL) target = fileURLToPath(path);
        else if (typeof path === 'string' || Buffer.isBuffer(path)) target = String(path);
        else throw invalidArgType('path', 'of type string or an instance of Buffer or URL', path);
        if (target.includes('\0'))
          throw Object.assign(
            new TypeError(
              "The argument 'path' must be a string, Uint8Array, or URL without null bytes. " +
                `Received '${target.replace(/\0/g, '\\x00')}'`,
            ),
            { code: 'ERR_INVALID_ARG_VALUE' },
          );
      }
      if (!fs.readFileSync) throw fault('EPROTO', 'Missing filesystem read');
      let text: string;
      try {
        text = String(fs.readFileSync(target, 'utf8'));
      } catch (error) {
        // Node reports the failed open with its syscall and path, as fs does.
        if (record(error) && typeof error.code === 'string' && !('syscall' in error))
          Object.assign(error, { syscall: 'open', path: target });
        throw error;
      }
      const variables = parseEnv(text);
      // A variable the environment already has keeps its value.
      for (const [key, value] of variables)
        if (!Object.hasOwn(process.env, key)) process.env[key] = value;
    },
  });
  installIdentity(process, process.execPath);
  const diagnosticReport = createReport({
    process,
    // A worker thread's id is its boot pid (createWorkerThreads); the main thread is 0.
    threadId: boot.thread ? boot.pid : 0,
    writeFile: (target, text) => {
      if (!fs.writeFileSync) throw fault('EPROTO', 'Missing filesystem write');
      fs.writeFileSync(target, text);
    },
    write: (name, text) => (name === 'stderr' ? diagnostic(text) : output(name, text)),
  });
  // A getter, as in Node.
  Object.defineProperty(process, 'report', {
    enumerable: true,
    configurable: true,
    get: () => diagnosticReport,
  });
  let loopExitedAt = -1;
  const lifecycle = createLifecycle({
    process,
    mode: () => rejectionMode,
    terminate,
    report,
    diagnostic,
    unsettled: () => {
      output('stderr', 'Warning: Detected unsettled top-level await\n');
    },
    alive: isAlive,
    evaluating: () => evaluating,
    recheck: idle,
    wake: () => {
      flushParkedTimers();
      if (idleTimer !== undefined) {
        hostClearTimeout(idleTimer);
        idleTimer = undefined;
        if (!isAlive()) idle();
      }
    },
    loopExit: () => {
      loopExitedAt = performance.now();
    },
    finish: dropParkedTimers,
    // Two turns, like the drain check: rejection reporting is itself a queued task.
    later: (fn) => {
      hostSetTimeout(() => hostSetTimeout(fn, 0), 0);
    },
    microtask: hostQueueMicrotask,
    tick: (fn) => process.nextTick(fn),
    context: asyncContext?.lifecycle,
  });
  let rejectionMode = startup.unhandledRejections ?? 'throw';
  uncaught = lifecycle.uncaught;
  rejected = lifecycle.rejected;
  rejectionHandled = lifecycle.handled;
  installUncaughtOffer(lifecycle.offer);
  // Browser stream dependencies schedule through process/browser, whose cached
  // host timers bypass guest Timeout bookkeeping. Own each queued callback until
  // delivery so idle exit cannot discard stream completion or error callbacks.
  browserProcess.nextTick = (callback, ...args) => {
    // Node drops ticks scheduled once `exit` has been emitted.
    if (process._exiting) return;
    const invoke = asyncContext ? asyncContext.once(callback, 'TickObject') : callback;
    retainHandle();
    try {
      shimNextTick(() => {
        try {
          invoke(...args);
        } finally {
          releaseHandle();
        }
      });
    } catch (error) {
      releaseHandle();
      throw error;
    }
  };
  const ipc =
    boot.ipcPort instanceof MessagePort
      ? attachIpc(
          process,
          boot.ipcPort,
          retainHandle,
          releaseHandle,
          true,
          boot.ipcSerialization ?? 'json',
          { emitted: () => emittedOutputs },
        )
      : undefined;
  // One handle type for timeouts and intervals, as in Node. A handle is in
  // `timers` exactly while a host timer is armed for it, which is what keeps the
  // process alive; an unreferenced timer whose host delay elapses during drain is
  // disarmed and parked in `parkedUnrefTimers` until referenced work wakes the
  // loop or natural exit commits. A timeout that has fired stays usable by
  // refresh() until it is cleared.
  class GuestTimeout {
    #referenced = true;
    #cleared = false;
    #timer: ReturnType<typeof setTimeout> | undefined;
    // Stable across re-arming, so a numeric handle keeps identifying this timer.
    #id = 0;
    #callback: (...args: unknown[]) => unknown;
    #delay: number;
    #repeat: boolean;
    #args: unknown[];
    #type: string;
    // Experimental async context: the handle is a resource, so the callback runs
    // in the context that created the timer on every repeat, and hooks see it.
    #resource:
      | {
          run(fn: (...args: unknown[]) => unknown, receiver: unknown, args: unknown[]): unknown;
          destroy(): void;
        }
      | undefined;

    constructor(
      fn: (...args: unknown[]) => void,
      delay: number,
      args: unknown[],
      repeat = false,
      type = 'Timeout',
    ) {
      this.#callback = fn;
      this.#delay = delay;
      this.#repeat = repeat;
      this.#args = args;
      this.#type = type;
      this.#arm(delay);
    }

    #arm(delay: number) {
      this.#resource ??= asyncContext?.resource(this.#type, this);
      this.#timer = hostSetTimeout(() => {
        if (lifecycle.finishing()) {
          this.#disarm();
          this.#resource = undefined;
          return;
        }
        // Node runs no unreferenced timer once `beforeExit` has begun without
        // referenced work waking the loop; park it so ref() or later wakeup still
        // runs its callback instead of stranding a dead handle in `timers`.
        if (!this.#referenced && lifecycle.draining()) {
          this.#disarm();
          parkedUnrefTimers.set(this.#id, this);
          return;
        }
        // A referenced timer that runs is loop work between two `beforeExit` events.
        if (this.#referenced) lifecycle.worked();
        const started = performance.now();
        this.#disarm();
        asyncContext?.flushDestroys();
        try {
          if (this.#resource) this.#resource.run(this.#callback, this, this.#args);
          else Reflect.apply(this.#callback, this, this.#args);
        } finally {
          // Node schedules the next run from the start of this one. A callback
          // that cleared or refreshed its own handle has already decided.
          if (this.#repeat && !this.#cleared && this.#timer === undefined)
            this.#arm(Math.max(1, this.#delay - (performance.now() - started)));
          // A timer that will not run again is destroyed; refresh() makes a new one.
          if (this.#timer === undefined && !this.#cleared && !parkedUnrefTimers.has(this.#id))
            this.#release();
          idle();
        }
      }, delay);
      this.#id ||= Number(this.#timer);
      timers.set(this.#id, this);
      if (this.#referenced) scheduleAliveCheck();
    }

    #release() {
      this.#resource?.destroy();
      this.#resource = undefined;
    }

    #disarm() {
      if (this.#timer === undefined) return;
      hostClearTimeout(this.#timer);
      this.#timer = undefined;
      timers.delete(this.#id);
    }

    resumeParked() {
      if (this.#cleared || this.#timer !== undefined) return;
      this.#arm(0);
    }

    dropParked() {
      this.#resource = undefined;
    }

    ref() {
      if (!this.#referenced) {
        this.#referenced = true;
        if (!this.#cleared) {
          if (parkedUnrefTimers.delete(this.#id)) {
            this.#arm(0);
          } else if (this.#timer !== undefined) {
            scheduleAliveCheck();
          }
        }
      }
      return this;
    }

    unref() {
      if (this.#referenced) {
        this.#referenced = false;
        idle();
      }
      return this;
    }

    hasRef() {
      return this.#referenced;
    }

    /** Restarts the full delay without allocating a handle; a cleared timer stays cleared. */
    refresh() {
      if (this.#cleared) return this;
      parkedUnrefTimers.delete(this.#id);
      this.#disarm();
      this.#arm(this.#delay);
      return this;
    }

    close() {
      this.cancel();
      return this;
    }

    [Symbol.toPrimitive]() {
      return this.#id;
    }

    cancel() {
      if (this.#cleared) return;
      this.#cleared = true;
      parkedUnrefTimers.delete(this.#id);
      this.#release();
      if (this.#timer === undefined) return;
      this.#disarm();
      idle();
    }
  }
  Object.defineProperty(GuestTimeout, 'name', { configurable: true, value: 'Timeout' });
  const guestSetTimeout = (fn: (...args: unknown[]) => void, delay = 1, ...args: unknown[]) => {
    if (typeof fn !== 'function')
      throw fault('ERR_INVALID_ARG_TYPE', 'Callback must be a function');
    return new GuestTimeout(fn, delay, args);
  };
  const guestClearTimeout = (timer: unknown) => {
    if (timer instanceof GuestTimeout) timer.cancel();
    else if (typeof timer === 'number' || typeof timer === 'string') {
      const id = Number(timer);
      (timers.get(id) ?? parkedUnrefTimers.get(id))?.cancel();
    }
  };
  const guestSetInterval = (
    fn: (...args: unknown[]) => void,
    delay?: unknown,
    ...args: unknown[]
  ) => {
    if (typeof fn !== 'function')
      throw fault('ERR_INVALID_ARG_TYPE', 'Callback must be a function');
    // Node coerces the repeat delay and uses 1 ms for anything outside 1..2^31-1.
    const repeat = Number(delay);
    return new GuestTimeout(fn, repeat >= 1 && repeat <= 2147483647 ? repeat : 1, args, true);
  };
  const guestTimers = {
    setTimeout: guestSetTimeout,
    clearTimeout: guestClearTimeout,
    setImmediate: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
      if (typeof fn !== 'function')
        throw fault('ERR_INVALID_ARG_TYPE', 'Callback must be a function');
      return new GuestTimeout(fn, 0, args, false, 'Immediate');
    },
    clearImmediate: (timer: unknown) => guestClearTimeout(timer),
    setInterval: guestSetInterval,
    // Node's clearInterval and clearTimeout accept each other's handles.
    clearInterval: (timer: unknown) => guestClearTimeout(timer),
  };
  const timersBuiltins = createTimersBuiltins({
    guestTimers,
    guestSetTimeout,
    guestClearTimeout,
    kCustomPromisifiedSymbol,
  });
  if (asyncContext) {
    // A throwing hook is fatal in Node: its stack is printed and the process exits 1.
    asyncContext.setFatal((error) => {
      try {
        output('stderr', (error instanceof Error ? error.stack : String(error)) + '\n');
      } catch (writeError) {
        if (!record(writeError) || writeError.code !== 'EPIPE') throw writeError;
      }
      // No guest frame may run again, not even a catch block around the code
      // that created the resource. The host terminates this Worker on exit.
      terminate(1);
    });
  }
  const GuestEventEmitter = createEventsBuiltin({
    nextTick: (callback, ...args) => process.nextTick(callback, ...args),
    setTimeout: guestSetTimeout,
    createEventEmitterAsyncResource: asyncContext
      ? (base) => asyncContext.createEventEmitterAsyncResource(base)
      : undefined,
  });
  // Experimental mode lowers async functions to ordinary ones, so the engine no
  // longer classifies them. A function the compiler lowered is recognizable from
  // its source, read through the saved built-in: its whole body is one call to
  // the compiler's helper, after the guard against `new` that the runtime gives
  // lowered `function` forms. It must also carry the async prototype the
  // runtime's marking gave it, so a package's own down-levelled function with
  // the same shape stays an ordinary function, as in Node.
  if (asyncContext)
    setLoweredFunctionKind((value) => {
      const helper =
        /^(?:[^{=]*\{\s*(?:if \(new\.target\) __contextEval_\w+\.x\(new\.target\);\s*)?return\s+|[^{=]*=>\s*)(__async(?:Generator)?)\d*\((?:this|null),/.exec(
          Reflect.apply(savedFunctionToString, value, []) as string,
        )?.[1];
      if (helper === undefined) return undefined;
      const generator = helper === '__asyncGenerator';
      const marked = generator ? asyncGeneratorFunctionPrototype : asyncFunctionPrototype;
      if (savedGetPrototypeOf(value) !== marked) return undefined;
      return generator ? 'AsyncGeneratorFunction' : 'AsyncFunction';
    });
  const inspector = createInspector(Boolean(boot.thread));
  // WebCrypto operations settle off-thread, and pending guest promises alone do not
  // keep a process alive, so installSubtleCryptoKeyCapture replaces all twelve
  // SubtleCrypto.prototype methods once per Worker to hold process retention until
  // settlement, materialize synthetic KeyObject#toCryptoKey keys, and capture key
  // material for KeyObject.from across importKey, generateKey, deriveKey, and unwrapKey.
  installSubtleCryptoKeyCapture(holdHandle);
  // Native Blob and body reads settle off-thread too; see native-read-retention.ts.
  retainNativeReads(holdHandle);
  const streamBuiltins = createStreamBuiltins(asyncContext?.capture);
  const netBuiltin = createNetBuiltin({
    sys,
    process,
    retain: retainHandle,
    release: releaseHandle,
    events: GuestEventEmitter,
    stream: streamBuiltins.stream,
    setTimeout: guestSetTimeout,
    clearTimeout: guestClearTimeout,
    setImmediate: guestTimers.setImmediate,
  });
  const tlsBuiltin = createTlsBuiltin({ net: netBuiltin });
  const { http, https } = createHttpBuiltins({
    sys,
    retain: retainHandle,
    release: releaseHandle,
    httpAgentMode: boot.httpAgentMode,
    httpOmitHeaders: boot.httpOmitHeaders,
    responseBytes: limits.http.responseBytes,
    process,
    events: GuestEventEmitter,
    stream: streamBuiltins.stream,
    net: netBuiltin,
    tls: tlsBuiltin,
    setTimeout: guestSetTimeout,
    clearTimeout: guestClearTimeout,
    setImmediate: guestTimers.setImmediate,
    clearImmediate: guestTimers.clearImmediate,
    setInterval: guestSetInterval,
    clearInterval: guestTimers.clearInterval,
  });
  let stdinChunksReceived = 0;
  let stdinEnded = !boot.stdinPipe;
  let wasmStdinReceive: ((id: number, bytes: Uint8Array | null) => void) | null = null;
  let activeWasmCleanup: (() => void) | null = null;
  self.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (record(message) && message.type === 'terminal-resize' && message.version === VERSION) {
      if (!terminal) return;
      try {
        const size = terminalDimensions(message.dimensions);
        for (const output of [process.stdout, process.stderr]) {
          if (!output.isTTY) continue;
          if (output.columns === size.columns && output.rows === size.rows) continue;
          output.columns = size.columns;
          output.rows = size.rows;
          output.emit('resize');
        }
        terminal = size;
      } catch (error) {
        fail(error);
      }
      return;
    }
    if (
      record(message) &&
      message.type === 'signal' &&
      message.version === VERSION &&
      (message.signal === 'SIGTERM' || message.signal === 'SIGINT') &&
      // A terminal interrupt carries a positive id to acknowledge; a parent's
      // ChildProcess#kill('SIGINT') carries none and expects no acknowledgement.
      (message.id === undefined ||
        (message.signal === 'SIGINT' &&
          typeof message.id === 'number' &&
          Number.isSafeInteger(message.id) &&
          message.id > 0))
    ) {
      if (process.listenerCount(message.signal) > 0) {
        process.emit(message.signal, message.signal, message.signal === 'SIGINT' ? 2 : 15);
        if (message.id !== undefined)
          self.postMessage({ type: 'signal-ack', version: VERSION, id: message.id });
      } else {
        activeWasmCleanup?.();
        activeWasmCleanup = null;
        self.postMessage({
          type: 'exit',
          code: message.signal === 'SIGINT' ? 130 : 143,
          signal: message.signal,
        });
        self.close();
      }
      return;
    }
    if (
      record(message) &&
      message.type === 'stdin' &&
      message.version === VERSION &&
      typeof message.id === 'number' &&
      (message.bytes === null || message.bytes instanceof Uint8Array)
    ) {
      if (message.bytes === null) stdinEnded = true;
      else stdinChunksReceived++;
      if (wasmStdinReceive !== null) {
        wasmStdinReceive(message.id, message.bytes);
        return;
      }
      try {
        input.receive(message.bytes);
        self.postMessage({ type: 'stdin-ack', version: VERSION, id: message.id });
      } catch (error) {
        self.postMessage({
          type: 'stdin-ack',
          version: VERSION,
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
          code: record(error) ? error.code : 'EIO',
        });
      }
      return;
    }
    if (
      !record(message) ||
      (message.type !== 'http' && message.type !== 'upgrade') ||
      typeof message.id !== 'number' ||
      typeof message.port !== 'number' ||
      typeof message.url !== 'string' ||
      typeof message.method !== 'string' ||
      !record(message.headers) ||
      !(message.body instanceof Uint8Array)
    )
      return;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(message.headers)) {
      if (typeof value !== 'string') return;
      headers[key] = value;
    }
    const request = {
      id: message.id,
      port: message.port,
      url: message.url,
      method: message.method,
      headers,
      body: message.body,
    };
    if (message.version !== VERSION || !(event.ports[0] instanceof MessagePort)) return;
    if (message.type === 'upgrade') {
      http.upgrade(request, event.ports[0]);
      return;
    }
    // A streamed preview exchange: the body, if any, follows on the port.
    if (
      message.bodyLength !== null &&
      (typeof message.bodyLength !== 'number' ||
        !Number.isSafeInteger(message.bodyLength) ||
        message.bodyLength < 0)
    )
      return;
    http.dispatch({ ...request, bodyLength: message.bodyLength }, event.ports[0]);
  };
  const fsBuiltins = createFsBuiltins({
    fs,
    sys,
    port: boot.port,
    cwd: () => cwd,
    retain: retainHandle,
    release: releaseHandle,
    worked: () => lifecycle.worked(),
    capture: asyncContext?.capture,
    process,
    events: GuestEventEmitter,
    stream: streamBuiltins.stream,
    setTimeout: guestSetTimeout,
    clearTimeout: guestClearTimeout,
    setInterval: guestSetInterval,
    clearInterval: guestTimers.clearInterval,
    setImmediate: guestTimers.setImmediate,
  });
  const threads = createWorkerThreadsBuiltin({
    defaults: () => ({ cwd, env: process.env, pid: process.pid, execArgv: startup.argv }),
    retain: retainHandle,
    release: releaseHandle,
    output: emitOutput,
    context:
      record(boot.thread) && boot.thread.port instanceof MessagePort && typeof boot.pid === 'number'
        ? { port: boot.thread.port, data: boot.thread.data, id: boot.pid }
        : undefined,
    process,
    events: GuestEventEmitter,
    stream: streamBuiltins.stream,
    fs: fsBuiltins.fs,
    setTimeout: guestSetTimeout,
    clearTimeout: guestClearTimeout,
    setImmediate: guestTimers.setImmediate,
  });
  const utilBuiltins = createUtilBuiltins(process);
  const readlineBuiltins = createReadlineBuiltins({
    process,
    setTimeout: guestSetTimeout,
    clearTimeout: guestClearTimeout,
  });
  const consoleBuiltin = createConsoleBuiltin({ guestConsole, process });
  const osBuiltin = createOsBuiltin({ process, advisoryFreeMemory });
  const cryptoBuiltin = createCryptoBuiltin({
    retain: holdHandle,
    setImmediate: (callback) => guestTimers.setImmediate(callback),
    schedule: (callback) => {
      hostSetTimeout(callback, 0);
    },
    process,
    stream: streamBuiltins.stream,
  });
  const builtins = {
    'timers/promises': timersBuiltins['timers/promises'],
    ...createAssertBuiltins(),
    constants: createConstantsBuiltin({
      osConstants: osBuiltin.constants,
      fsConstants: fsBuiltins.constants,
      cryptoConstants: cryptoBuiltin.constants,
    }),
    v8: createV8Builtin({
      advisoryHeapLimit: boot.advisoryHeapLimit,
      callTimeoutMs: limits.syscall.callTimeoutMs,
      process,
      stream: streamBuiltins.stream,
      fs: fsBuiltins.fs,
      cwd: () => cwd,
    }),
    fs: fsBuiltins.fs,
    'fs/promises': fsBuiltins['fs/promises'],
    ...createPathBuiltins(process),
    buffer: createBufferBuiltin({
      process,
      retain: holdHandle,
    }),
    events: GuestEventEmitter,
    timers: timersBuiltins.timers,
    async_hooks: asyncContext?.hooks ?? {
      AsyncLocalStorage,
      createHook: () => {
        throw fault(
          'ENOSYS',
          "Engine async hooks are unsupported; boot with asyncContext: 'experimental' to enable it",
        );
      },
    },
    ...streamBuiltins,
    ...utilBuiltins,
    process,
    perf_hooks: createPerfHooksBuiltin({
      setImmediate: (callback) => guestTimers.setImmediate(callback),
      hrtimeNs,
      setTimeout: guestSetTimeout,
      clearTimeout: guestClearTimeout,
      setInterval: guestSetInterval,
      clearInterval: guestTimers.clearInterval,
      process,
      getLoopExit: () => loopExitedAt,
    }),
    diagnostics_channel: createDiagnosticsChannelBuiltin(process),
    inspector: inspector.inspector,
    'inspector/promises': inspector.promises,
    ...readlineBuiltins,
    os: osBuiltin,
    child_process: createChildProcessBuiltin({
      defaults: () => ({ cwd, env: process.env, execArgv: process.execArgv }),
      retain: retainHandle,
      release: releaseHandle,
      emitOutput,
      outputPipes,
      sys,
      fs,
      onPrepareSync: (prepare) => {
        prepareSyncChild = prepare;
      },
    }),
    worker_threads: threads.module,
    console: consoleBuiltin,
    http: http.module,
    https,
    url: {
      ...url,
      URL,
      URLSearchParams,
      fileURLToPath,
      pathToFileURL: (value: string) => pathToFileURL(value, cwd),
      urlToHttpOptions,
      domainToASCII,
      domainToUnicode,
    },
    querystring: createQuerystringBuiltin(),
    string_decoder: createStringDecoderBuiltin(),
    crypto: cryptoBuiltin,
    zlib: createZlibBuiltin({
      retain: holdHandle,
      setImmediate: (callback) => guestTimers.setImmediate(callback),
      unzipBytes: limits.install.unzipBytes,
    }),
    tty: createTtyBuiltin({ process, getTerminal: () => terminal }),
    tls: tlsBuiltin,
    http2: createHttp2Builtin(),
    net: netBuiltin,
  };
  try {
    if (boot.command === 'sh' && boot.argv.length === 1 && boot.argv[0] === '-i') {
      if (!process.stdin.isTTY || !process.stderr.isTTY)
        throw fault('ENOTTY', 'Interactive shell requires terminal input and stderr');
      // Prompt Ctrl-C is handled by readline. During command startup/completion
      // the interactive shell survives SIGINT; its foreground tree owns the job.
      process.on('SIGINT', () => {});
      process.exitCode = await runInteractiveShell(
        process.stdin,
        process.stderr,
        typeof process.env.PS1 === 'string' ? process.env.PS1 : '$ ',
        (source) =>
          runShell(
            parseShell(['-c', source]),
            cwd,
            process.env,
            fs,
            builtins.child_process.spawn,
            (text) => output('stderr', text),
          ),
        (text) => output('stderr', text),
        () => self.postMessage({ type: 'terminal-prompt', version: VERSION }),
      );
      evaluating = false;
      idle();
      return;
    }
    const program = boot.command === 'sh' ? parseShell(boot.argv) : undefined;
    if (program && (program.length > 1 || program[0]?.redirects.length)) {
      process.exitCode = await runShell(
        program,
        cwd,
        process.env,
        fs,
        builtins.child_process.spawn,
        (text) => output('stderr', text),
      );
      evaluating = false;
      idle();
      return;
    }
    const argv = program?.[0] ? shellEntry(program[0], cwd, process.env, fs) : boot.argv;
    const entry = argv[0];
    if (typeof entry !== 'string') throw fault('EINVAL', 'Missing process entry');
    if (boot.command === 'sh') process.argv = ['/bin/node', ...argv];
    // Node validates NODE_OPTIONS even when a command-line flag takes precedence.
    const environment = nodeOptionsRejectionMode(process.env.NODE_OPTIONS);
    if (environment.problem) {
      output('stderr', `/bin/node: ${environment.problem}\n`);
      self.postMessage({ type: 'exit', code: 9 });
      self.close();
      return;
    }
    rejectionMode = startup.unhandledRejections ?? environment.mode ?? rejectionMode;
    const resolvedEntry = path.resolve(cwd, entry);
    const wasmEntry = isWasmBinary(fs, resolvedEntry);
    const syncHelperReady = !wasmEntry
      ? prepareSyncChild?.(resolvedEntry, startup.preloads, cwd)
      : undefined;
    await initializeCryptoComparison();
    if (!wasmEntry && boot.stdinPipe && !terminal && !fileStdio.includes(0) && !stdinEnded) {
      await new Promise<void>((resolve) => hostSetTimeout(resolve, 0));
      if (stdinChunksReceived > 0 && !stdinEnded)
        await new Promise<void>((resolve) => hostSetTimeout(resolve, 0));
    }
    if (wasmEntry) {
      if (!fs.readFileSync) throw fault('EPROTO', 'Missing filesystem read');
      const rawBytes = fs.readFileSync(resolvedEntry);
      const wasmBytes =
        rawBytes instanceof Uint8Array
          ? Uint8Array.from(rawBytes)
          : Uint8Array.from(Buffer.from(String(rawBytes)));
      const wasiEnv: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) wasiEnv[key] = String(value);
      }
      if (!fileStdio.includes(0) && typeof HostWorker === 'function') {
        const stdinSab = new SharedArrayBuffer(64 + 65536);
        const stdinCtrl = new Int32Array(stdinSab, 0, 16);
        const stdinPayload = new Uint8Array(stdinSab, 64);
        const wasmStdinQueue: Array<Uint8Array | null> = [];
        let wasmBufferedBytes = 0;
        const wasmDeferredAcks: number[] = [];

        Atomics.store(stdinCtrl, WASM_STDIN_CTRL_KERNEL_READY, 1);

        const wakeWasmStdin = () => {
          Atomics.add(stdinCtrl, WASM_STDIN_CTRL_EPOCH, 1);
          Atomics.notify(stdinCtrl, WASM_STDIN_CTRL_EPOCH, 1);
        };

        const pumpWasmStdin = () => {
          if (Atomics.load(stdinCtrl, WASM_STDIN_CTRL_PKT_STATE) !== WASM_STDIN_PKT_EMPTY) return;
          const next = wasmStdinQueue.shift();
          if (next === undefined) return;
          if (next === null) {
            Atomics.store(stdinCtrl, WASM_STDIN_CTRL_PKT_LEN, 0);
            Atomics.store(stdinCtrl, WASM_STDIN_CTRL_PKT_STATE, WASM_STDIN_PKT_EOF);
            wakeWasmStdin();
            return;
          }
          wasmBufferedBytes -= next.byteLength;
          stdinPayload.set(next, 0);
          Atomics.store(stdinCtrl, WASM_STDIN_CTRL_PKT_LEN, next.byteLength);
          Atomics.store(stdinCtrl, WASM_STDIN_CTRL_PKT_STATE, WASM_STDIN_PKT_DATA);
          wakeWasmStdin();
          while (wasmDeferredAcks.length > 0 && wasmBufferedBytes <= limits.child.pipeBytes) {
            const ackId = wasmDeferredAcks.shift();
            if (ackId !== undefined) {
              self.postMessage({ type: 'stdin-ack', version: VERSION, id: ackId });
            }
          }
        };

        wasmStdinReceive = (id: number, bytes: Uint8Array | null) => {
          if (bytes === null) {
            wasmStdinQueue.push(null);
            self.postMessage({ type: 'stdin-ack', version: VERSION, id });
            pumpWasmStdin();
            return;
          }
          if (bytes.byteLength === 0) {
            self.postMessage({ type: 'stdin-ack', version: VERSION, id });
            return;
          }
          for (let off = 0; off < bytes.byteLength; off += 65536) {
            const part = bytes.subarray(off, Math.min(off + 65536, bytes.byteLength)).slice();
            wasmStdinQueue.push(part);
            wasmBufferedBytes += part.byteLength;
          }
          if (wasmBufferedBytes <= limits.child.pipeBytes) {
            self.postMessage({ type: 'stdin-ack', version: VERSION, id });
          } else {
            wasmDeferredAcks.push(id);
          }
          pumpWasmStdin();
        };

        pumpWasmStdin();

        const bootPort = boot.port;
        if (!(bootPort instanceof MessagePort)) throw fault('EPROTO', 'Missing boot syscall port');
        const syscallProxy = new MessageChannel();
        syscallProxy.port1.onmessage = (ev: MessageEvent<unknown>) => {
          bootPort.postMessage(ev.data);
        };
        const onBootPortMessage = (ev: MessageEvent<unknown>) => {
          if (record(ev.data) && ev.data.version === VERSION && ev.data.type === 'stdin-ready') {
            Atomics.store(stdinCtrl, WASM_STDIN_CTRL_KERNEL_READY, 1);
            wakeWasmStdin();
          }
        };
        bootPort.addEventListener('message', onBootPortMessage);

        let cleanedUp = false;
        const cleanupWasmRunner = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          wasmStdinReceive = null;
          bootPort.removeEventListener('message', onBootPortMessage);
          syscallProxy.port1.onmessage = null;
          syscallProxy.port1.close();
        };
        activeWasmCleanup = cleanupWasmRunner;

        const runner = new HostWorker(new URL('process.js', import.meta.url), { type: 'module' });
        let exitCode = 1;
        try {
          exitCode = await new Promise<number>((resolve) => {
            runner.onmessage = (ev: MessageEvent<unknown>) => {
              const msg = ev.data;
              if (!record(msg) || msg.version !== VERSION) return;
              if (msg.type === 'wasm-stdin-consumed') {
                pumpWasmStdin();
              } else if (
                msg.type === 'wasm-output' &&
                (msg.stream === 'stdout' || msg.stream === 'stderr') &&
                msg.bytes instanceof Uint8Array
              ) {
                emitOutput(msg.stream, msg.bytes);
              } else if (msg.type === 'wasm-exit' && typeof msg.code === 'number') {
                resolve(msg.code);
              }
            };
            runner.onerror = () => {
              resolve(1);
            };
            runner.postMessage(
              {
                type: 'wasm-stdin-runner',
                version: VERSION,
                port: syscallProxy.port2,
                shared: boot.shared,
                stdinSab,
                wasmBuffer: wasmBytes.buffer,
                argv,
                env: wasiEnv,
                cwd,
                resources: boot.resources,
                outputPipes,
                fileStdio,
              },
              [syscallProxy.port2, wasmBytes.buffer],
            );
          });
        } finally {
          activeWasmCleanup = null;
          cleanupWasmRunner();
        }
        self.postMessage({ type: 'exit', code: exitCode });
        self.close();
        return;
      }

      const WASI = createWasiClass({
        fs,
        sys,
        cwd: () => cwd,
        hrtimeNs,
        exit: (code) => terminate(code),
      });
      const wasi = new WASI({
        version: 'preview1',
        args: argv,
        env: wasiEnv,
        preopens: { '/': '/', '.': cwd },
        stdin: 0,
        stdout: 1,
        stderr: 2,
        returnOnExit: true,
      });
      const wasmModule = new WebAssembly.Module(wasmBytes);
      const wasmInstance = new WebAssembly.Instance(wasmModule, wasi.getImportObject());
      process.exitCode = wasi.start(wasmInstance);
      evaluating = false;
      ipc?.ready();
      threads.ready();
      idle();
      return;
    }
    await syncHelperReady;
    const compileContext = asyncContext
      ? await createContextCompiler(asyncContext.modules)
      : undefined;
    asyncContext?.install();
    let sqliteBuiltin: ReturnType<typeof createSqliteBuiltin> | undefined;
    const loaderBuiltins: Record<string, unknown> = Object.defineProperty(
      { ...builtins, ...createDnsBuiltins(builtins.net.isIP) },
      'sqlite',
      {
        enumerable: true,
        configurable: true,
        get: () => {
          if (!sqliteBuiltin) {
            warnings.emitWarning(
              'SQLite is an experimental feature and might change at any time',
              'ExperimentalWarning',
            );
            sqliteBuiltin = createSqliteBuiltin({ fs: fsBuiltins.fs, cwd: () => cwd });
          }
          return sqliteBuiltin;
        },
      },
    );
    Object.defineProperty(loaderBuiltins, 'wasi', {
      enumerable: true,
      configurable: true,
      get: createWasiBuiltin({
        fs,
        sys,
        cwd: () => cwd,
        hrtimeNs,
        exit: (code) => process.exit(code),
        process,
      }),
    });
    const loader = createLoader(
      fs,
      loaderBuiltins,
      {
        // Node dependencies must not attach browser-worker message handlers to our transport.
        WorkerGlobalScope: undefined,
        process,
        console: consoleBuiltin,
        ...guestTimers,
      },
      {
        compileContext,
        moduleContext: asyncContext?.modules,
        base: boot.moduleBase,
        cwd: () => cwd,
        retain: holdHandle,
        // Publication has no deadline: the host answers every request, published or
        // failed, when its event loop turns, and a host page busy in synchronous code
        // only delays the import, as a busy disk delays a native one.
        publish: (modules) =>
          new Promise<void>((resolve, reject) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = (event: MessageEvent<unknown>) => {
              channel.port1.close();
              try {
                unwrap(event.data);
                resolve();
              } catch (error) {
                reject(error);
              }
            };
            try {
              self.postMessage({ type: 'publish-modules', version: VERSION, modules }, [
                channel.port2,
              ]);
            } catch (error) {
              channel.port1.close();
              reject(error);
            }
          }),
      },
      startup,
    );
    // process.md "process.getBuiltinModule(id)": the builtin `id` names, always the
    // builtin even if require.cache was changed, or undefined for a non-builtin. A
    // Node builtin this runtime lacks fails as require('node:<id>') does (ENOSYS).
    Object.assign(process, {
      getBuiltinModule: (id: unknown) => {
        if (typeof id !== 'string') throw invalidArgType('id', 'of type string', id);
        if (!isBuiltin(id)) return undefined;
        return loader.load(id.startsWith('node:') ? id : `node:${id}`);
      },
    });
    registerExtraLibBuiltins(loaderBuiltins, {
      process,
      fs: fsBuiltins.fs,
      cwd: () => cwd,
      setTimeout: guestSetTimeout,
      clearTimeout: guestClearTimeout,
      setImmediate: guestTimers.setImmediate,
      retain: retainHandle,
      release: releaseHandle,
      util: utilBuiltins.util,
      events: GuestEventEmitter,
      readline: readlineBuiltins.readline,
      stream: streamBuiltins.stream,
      tty: builtins.tty,
      console: consoleBuiltin,
      asyncHooks: builtins.async_hooks,
      vm: loaderBuiltins.vm,
      module: loaderBuiltins.module,
    });
    registerTestRunnerBuiltins(loaderBuiltins, {
      process,
      fs: fsBuiltins.fs,
      cwd: () => cwd,
      setTimeout: guestSetTimeout,
      clearTimeout: guestClearTimeout,
      setInterval: guestSetInterval,
      clearInterval: guestTimers.clearInterval,
      setImmediate: guestTimers.setImmediate,
      clearImmediate: guestTimers.clearImmediate,
      hrtimeNs,
      retain: retainHandle,
      release: releaseHandle,
      loadModule: loader.load,
      importModule: (specifier: string, parent = '/entry.mjs') => loader.import(parent, specifier),
      events: GuestEventEmitter,
      stream: streamBuiltins.stream,
      util: utilBuiltins.util,
      asyncHooks: builtins.async_hooks,
    });
    if (boot.thread) self.postMessage({ type: 'thread-online', version: VERSION });
    let failure: { error: unknown } | undefined;
    try {
      // A CommonJS entry's throw is raised in the turn it happens; returning
      // from `uncaught` means a listener took it and the process goes on.
      await loader.run(path.resolve(cwd, entry), cwd, (error) =>
        uncaught(error, 'uncaughtException'),
      );
    } catch (error) {
      failure = { error };
    }
    // A failed entry has settled, so it is not an unsettled top-level await.
    evaluating = false;
    // Node reports a failed ESM entry as a rejection.
    if (failure) uncaught(failure.error, 'unhandledRejection');
    ipc?.ready();
    threads.ready();
    idle();
  } catch (error) {
    if (error instanceof ShellError) {
      try {
        output('stderr', `sh: ${error.code}: ${error.message}\n`);
        self.postMessage({ type: 'exit', code: error.status });
      } catch (writeError) {
        if (!record(writeError) || writeError.code !== 'EPIPE') throw writeError;
        self.postMessage({ type: 'exit', code: 141, signal: 'SIGPIPE' });
      }
      self.close();
    } else fail(error);
  }
};
