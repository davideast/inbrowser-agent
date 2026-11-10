import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import path from 'path-browserify';
import { Readable, Writable } from 'readable-stream/lib/stream.js';
import * as util from 'util/';
import { isBuiltin } from './builtin-modules';
import { type StdioSlot, forkStdio, markHandleStream, normalizeStdio } from './child-stdio';
import { captured } from './context-hook';
import { parseExecArgv } from './exec-argv';
import { fileURLToPath } from './file-url';
import type { createFs } from './fs';
import { attachIpc } from './ipc';
import {
  invalidArgType,
  invalidArgValue,
  nodeError,
  outOfRange,
  validateObject,
} from './node-errors';
import { type OutputPipes, closeOutputPipe } from './output-pipe';
import { type StdioBindings, VERSION, fault, record } from './protocol';
import { resourceLimits } from './resource-policy';
import { kCustomPromisifiedSymbol } from './util-promisify';
import { isWasmBinary } from './wasi';

const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
const hostQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
const HostWorker = globalThis.Worker;
const textEncoder = new TextEncoder();

const MAX_BUFFER = 1024 * 1024;
const SYNC_EXTRA_OPTIONS = new Set(['input', 'maxBuffer', 'encoding']);
const SYNC_HEADER_BYTES = 64;
const SYNC_MIN_SAB_BYTES = SYNC_HEADER_BYTES + 1024;
const SYNC_DEFAULT_PAYLOAD_BYTES = 256 * 1024;

const SYNC_CTRL_OP = 0;
const SYNC_CTRL_LEN_OR_PID = 1;
const SYNC_CTRL_HAS_STATUS = 2;
const SYNC_CTRL_STATUS = 3;
const SYNC_CTRL_SIGNAL = 4;
const SYNC_CTRL_ERR_KIND = 5;
const SYNC_CTRL_ERR_LEN = 6;
const SYNC_CTRL_ACK = 8;

const SYNC_OP_IDLE = 0;
const SYNC_OP_PIPE_STDOUT = 1;
const SYNC_OP_PIPE_STDERR = 2;
const SYNC_OP_INHERIT_STDOUT = 3;
const SYNC_OP_INHERIT_STDERR = 4;
const SYNC_OP_DONE = 7;

const SYNC_ERR_NONE = 0;
const SYNC_ERR_TIMEOUT = 1;
const SYNC_ERR_MAXBUFFER = 2;
const SYNC_ERR_FAULT = 3;

const SIGNAL_FROM_CODE: Record<number, ExitSignal> = {
  0: null,
  1: 'SIGTERM',
  2: 'SIGINT',
  3: 'SIGKILL',
  4: 'SIGPIPE',
  5: 'SIGABRT',
};
const CODE_FROM_SIGNAL: Record<string, number> = {
  SIGTERM: 1,
  SIGINT: 2,
  SIGKILL: 3,
  SIGPIPE: 4,
  SIGABRT: 5,
};

export function installSyncWaitHelper(): void {
  let activeAbort: ((reason: unknown) => void) | null = null;
  self.addEventListener('error', (event: ErrorEvent) => {
    event.preventDefault();
    activeAbort?.(event.error ?? event.message);
  });
  self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    event.preventDefault();
    activeAbort?.(event.reason);
  });

  self.onmessage = (initEvent: MessageEvent<unknown>) => {
    const cfg = initEvent.data;
    const closeInitPorts = () => {
      for (const p of initEvent.ports) {
        try {
          p.close();
        } catch {
          // Port may already be closed.
        }
      }
      if (record(cfg) && cfg.port instanceof MessagePort) {
        try {
          cfg.port.close();
        } catch {
          // Port may already be closed.
        }
      }
    };
    if (
      !record(cfg) ||
      cfg.type !== 'run' ||
      cfg.version !== VERSION ||
      !(cfg.port instanceof MessagePort) ||
      !(cfg.sab instanceof SharedArrayBuffer) ||
      cfg.sab.byteLength < SYNC_MIN_SAB_BYTES ||
      typeof cfg.timeout !== 'number' ||
      !Number.isInteger(cfg.timeout) ||
      cfg.timeout < 0 ||
      typeof cfg.killSignal !== 'string' ||
      !Object.hasOwn(CODE_FROM_SIGNAL, cfg.killSignal) ||
      typeof cfg.maxBuffer !== 'number' ||
      Number.isNaN(cfg.maxBuffer) ||
      cfg.maxBuffer < 0
    ) {
      closeInitPorts();
      return;
    }
    const port = cfg.port;
    const version = cfg.version;
    const killSignal = cfg.killSignal;
    const maxBuffer = cfg.maxBuffer;
    const ignoredStdout = cfg.ignoredStdout === true;
    const ignoredStderr = cfg.ignoredStderr === true;
    const routeStdout =
      cfg.routeStdout === 'stdout' ? 'stdout' : cfg.routeStdout === 'stderr' ? 'stderr' : null;
    const routeStderr =
      cfg.routeStderr === 'stdout' ? 'stdout' : cfg.routeStderr === 'stderr' ? 'stderr' : null;
    const pipeStdout = cfg.pipeStdout === true;
    const pipeStderr = cfg.pipeStderr === true;

    const control = new Int32Array(cfg.sab, 0, 16);
    const payload = new Uint8Array(cfg.sab, SYNC_HEADER_BYTES);
    const chunkCap = payload.byteLength;

    let pid = 0;
    let done = false;
    let capturedBytes = 0;
    let errorKind = SYNC_ERR_NONE;
    let errorText = '';
    let killedByLimit = false;
    let recordedSignal = 0;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const sendPacket = (op: number, bytes: Uint8Array) => {
      if (bytes.byteLength === 0) return;
      let offset = 0;
      const total = bytes.byteLength;
      while (offset < total) {
        const len = Math.min(total - offset, chunkCap);
        payload.set(bytes.subarray(offset, offset + len), 0);
        Atomics.store(control, SYNC_CTRL_LEN_OR_PID, len);
        Atomics.store(control, SYNC_CTRL_ACK, 0);
        Atomics.store(control, SYNC_CTRL_OP, op);
        Atomics.notify(control, SYNC_CTRL_OP, 1);
        Atomics.wait(control, SYNC_CTRL_ACK, 0);
        offset += len;
      }
    };

    const finish = (hasStatus: number, status: number, signalCode: number) => {
      if (done) return;
      done = true;
      activeAbort = null;
      if (timeoutTimer !== null) hostClearTimeout(timeoutTimer);
      if (forceKillTimer !== null) hostClearTimeout(forceKillTimer);
      let errLen = 0;
      if (errorKind === SYNC_ERR_FAULT && errorText) {
        const encoded = textEncoder.encode(errorText);
        errLen = Math.min(encoded.byteLength, chunkCap);
        payload.set(encoded.subarray(0, errLen), 0);
      }
      Atomics.store(control, SYNC_CTRL_LEN_OR_PID, pid);
      Atomics.store(control, SYNC_CTRL_HAS_STATUS, killedByLimit ? 0 : hasStatus);
      Atomics.store(control, SYNC_CTRL_STATUS, status | 0);
      Atomics.store(control, SYNC_CTRL_SIGNAL, killedByLimit ? recordedSignal : signalCode);
      Atomics.store(control, SYNC_CTRL_ERR_KIND, errorKind);
      Atomics.store(control, SYNC_CTRL_ERR_LEN, errLen);
      Atomics.store(control, SYNC_CTRL_OP, SYNC_OP_DONE);
      Atomics.notify(control, SYNC_CTRL_OP, 1);
      try {
        port.close();
      } catch {
        // Port already closed.
      }
    };

    const abortWithFault = (reason: unknown) => {
      if (done) return;
      try {
        port.postMessage({ type: 'kill', version, signal: 'SIGKILL' });
      } catch {
        // Ignore closed port.
      }
      const code = record(reason) && typeof reason.code === 'string' ? reason.code : 'EIO';
      const msg = reason instanceof Error ? reason.message : String(reason);
      errorKind = SYNC_ERR_FAULT;
      errorText = `${code}\n${msg}`;
      finish(0, 0, 0);
    };
    activeAbort = abortWithFault;

    const triggerKill = (kind: number) => {
      if (done || killedByLimit) return;
      killedByLimit = true;
      errorKind = kind;
      recordedSignal = CODE_FROM_SIGNAL[killSignal] ?? 1;
      try {
        port.postMessage({ type: 'kill', version, signal: killSignal });
      } catch {
        // Ignore closed port.
      }
      if (killSignal !== 'SIGKILL') {
        forceKillTimer = hostSetTimeout(() => {
          if (!done) {
            try {
              port.postMessage({ type: 'kill', version, signal: 'SIGKILL' });
            } catch {
              // Ignore closed port.
            }
          }
        }, 25);
      }
    };

    try {
      if (cfg.timeout > 0) {
        timeoutTimer = hostSetTimeout(() => {
          timeoutTimer = null;
          triggerKill(SYNC_ERR_TIMEOUT);
        }, cfg.timeout);
      }

      const inputSource = cfg.inputBytes instanceof Uint8Array ? cfg.inputBytes : null;
      let inputOffset = 0;
      let nextInputId = 1;
      let inFlightInputs = 0;
      let inputEofSent = false;
      let inputClosed = false;
      const inputChunkSize = 65536;

      const pumpStdin = () => {
        if (!inputSource || done || inputClosed || inputEofSent) return;
        while (inFlightInputs < 4 && inputOffset < inputSource.byteLength) {
          const end = Math.min(inputOffset + inputChunkSize, inputSource.byteLength);
          const slice = inputSource.subarray(inputOffset, end);
          inputOffset = end;
          inFlightInputs++;
          try {
            port.postMessage({
              type: 'stdin',
              version,
              id: nextInputId++,
              bytes: slice,
            });
          } catch {
            inputClosed = true;
            return;
          }
        }
        if (inputOffset >= inputSource.byteLength && inFlightInputs === 0 && !inputEofSent) {
          inputEofSent = true;
          try {
            port.postMessage({ type: 'stdin', version, id: nextInputId++, bytes: null });
          } catch {
            inputClosed = true;
          }
        }
      };

      port.onmessage = (ev: MessageEvent<unknown>) => {
        try {
          const msg = ev.data;
          if (!record(msg) || msg.version !== version || done) return;
          if (msg.type === 'stdin-ack') {
            if (typeof msg.error === 'string') {
              inputClosed = true;
            } else {
              if (inFlightInputs > 0) inFlightInputs--;
              pumpStdin();
            }
          } else if (msg.type === 'stdin-error') {
            inputClosed = true;
          } else if (msg.type === 'spawned' && typeof msg.pid === 'number') {
            pid = msg.pid;
            pumpStdin();
          } else if (
            msg.type === 'output' &&
            (msg.stream === 'stdout' || msg.stream === 'stderr') &&
            msg.bytes instanceof Uint8Array
          ) {
            const isOut = msg.stream === 'stdout';
            if (isOut ? ignoredStdout : ignoredStderr) return;
            const route = isOut ? routeStdout : routeStderr;
            if (route === 'stdout') {
              sendPacket(SYNC_OP_INHERIT_STDOUT, msg.bytes);
            } else if (route === 'stderr') {
              sendPacket(SYNC_OP_INHERIT_STDERR, msg.bytes);
            } else if (isOut ? pipeStdout : pipeStderr) {
              if (!killedByLimit) {
                capturedBytes += msg.bytes.byteLength;
                sendPacket(isOut ? SYNC_OP_PIPE_STDOUT : SYNC_OP_PIPE_STDERR, msg.bytes);
                if (capturedBytes > maxBuffer) {
                  triggerKill(SYNC_ERR_MAXBUFFER);
                }
              }
            }
          } else if (msg.type === 'exit' && typeof msg.code === 'number') {
            const sig = typeof msg.signal === 'string' ? (CODE_FROM_SIGNAL[msg.signal] ?? 0) : 0;
            finish(sig ? 0 : 1, msg.code, sig);
          } else if (msg.type === 'error' && typeof msg.message === 'string') {
            errorKind = SYNC_ERR_FAULT;
            errorText = (typeof msg.code === 'string' ? msg.code : 'EIO') + '\n' + msg.message;
            finish(0, 0, 0);
          }
        } catch (error) {
          abortWithFault(error);
        }
      };
    } catch (error) {
      abortWithFault(error);
    }
  };
}

export type SupportedSignal = 'SIGTERM' | 'SIGINT' | 'SIGKILL';
type ExitSignal = SupportedSignal | 'SIGPIPE' | 'SIGABRT' | null;

export class ChildProcess extends EventEmitter {}

function validateNullFreeString(value: string, name: string): void {
  if (value.includes('\0')) {
    throw invalidArgValue(name, value, 'must be a string without null bytes');
  }
}

export function validateTimeout(timeout: unknown): void {
  if (
    timeout != null &&
    !(typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 0)
  ) {
    throw outOfRange('timeout', 'an unsigned integer', timeout);
  }
}

export function validateMaxBuffer(maxBuffer: unknown): void {
  if (maxBuffer != null && !(typeof maxBuffer === 'number' && maxBuffer >= 0)) {
    throw outOfRange('options.maxBuffer', 'a positive number', maxBuffer);
  }
}

export function sanitizeKillSignal(killSignal: unknown): SupportedSignal {
  if (killSignal == null) return 'SIGTERM';
  if (typeof killSignal === 'string') {
    if (killSignal === 'SIGTERM' || killSignal === 'SIGINT' || killSignal === 'SIGKILL') {
      return killSignal;
    }
    throw nodeError(TypeError, 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${killSignal}`);
  }
  if (typeof killSignal === 'number') {
    if (killSignal === 15) return 'SIGTERM';
    if (killSignal === 2) return 'SIGINT';
    if (killSignal === 9) return 'SIGKILL';
    return 'SIGTERM';
  }
  throw invalidArgType('options.killSignal', ['string', 'number'], killSignal);
}

const ALLOWED_SPAWN_OPTIONS = new Set([
  'cwd',
  'env',
  'stdio',
  'windowsHide',
  'windowsVerbatimArguments',
  'shell',
  'stdioString',
  'argv0',
  'timeout',
  'killSignal',
  'detached',
  'uid',
  'gid',
  'signal',
]);

export interface NormalizedSpawnSpec {
  originalFile: string;
  spawnargs: string[];
  effectiveFile: string;
  effectiveArgs: string[];
  cwd: string;
  env: Record<string, string>;
  stdio: unknown;
  timeout: number;
  killSignal: SupportedSignal;
}

export function normalizeSpawnSpec(
  file: unknown,
  args: unknown,
  options: unknown,
  defaults: () => { cwd: string; env: Record<string, unknown>; execArgv: string[] },
  extraAllowedKeys?: ReadonlySet<string>,
): { spec: NormalizedSpawnSpec; rawOptions: Record<string, unknown> } {
  if (typeof file !== 'string') throw invalidArgType('file', 'string', file);
  validateNullFreeString(file, 'file');
  if (file.length === 0) throw invalidArgValue('file', file, 'cannot be empty');

  let rawArgs: unknown[];
  let rawOpts: unknown = options;
  if (Array.isArray(args)) {
    rawArgs = Array.from(args);
  } else if (args == null) {
    rawArgs = [];
  } else if (typeof args !== 'object') {
    throw invalidArgType('args', 'object', args);
  } else {
    rawOpts = args;
    rawArgs = [];
  }

  const stringArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const item = rawArgs[i];
    if (typeof item !== 'string') {
      throw fault('EINVAL', 'Invalid child spawn arguments');
    }
    validateNullFreeString(item, `args[${i}]`);
    stringArgs.push(item);
  }

  let opts: Record<string, unknown>;
  if (rawOpts === undefined) {
    opts = {};
  } else {
    validateObject(rawOpts, 'options');
    opts = { ...rawOpts };
  }

  if (opts.stdioString !== undefined) {
    throw fault('ENOSYS', 'stdioString is not a child spawn option');
  }
  for (const key of Object.keys(opts)) {
    if (!ALLOWED_SPAWN_OPTIONS.has(key) && !extraAllowedKeys?.has(key)) {
      throw fault('ENOSYS', 'Unsupported child spawn option');
    }
  }
  if (opts.detached === true || opts.uid != null || opts.gid != null || opts.signal != null) {
    throw fault('ENOSYS', 'Unsupported child spawn option');
  }
  if (opts.detached !== undefined && typeof opts.detached !== 'boolean') {
    throw invalidArgType('options.detached', 'boolean', opts.detached);
  }
  if (opts.windowsHide != null && typeof opts.windowsHide !== 'boolean') {
    throw fault('EINVAL', 'windowsHide must be a boolean');
  }
  if (opts.windowsVerbatimArguments != null && typeof opts.windowsVerbatimArguments !== 'boolean') {
    throw invalidArgType(
      'options.windowsVerbatimArguments',
      'boolean',
      opts.windowsVerbatimArguments,
    );
  }
  if (opts.shell != null && typeof opts.shell !== 'boolean' && typeof opts.shell !== 'string') {
    throw invalidArgType('options.shell', ['boolean', 'string'], opts.shell);
  }
  if (opts.argv0 != null) {
    if (typeof opts.argv0 !== 'string') throw invalidArgType('options.argv0', 'string', opts.argv0);
    validateNullFreeString(opts.argv0, 'options.argv0');
  }

  validateTimeout(opts.timeout);
  const timeout = typeof opts.timeout === 'number' ? opts.timeout : 0;
  const killSignal = sanitizeKillSignal(opts.killSignal);

  const inherited = defaults();
  let cwd = inherited.cwd;
  if (opts.cwd != null) {
    let cwdStr: string;
    if (opts.cwd instanceof URL) {
      cwdStr = fileURLToPath(opts.cwd);
    } else if (
      record(opts.cwd) &&
      typeof opts.cwd.href === 'string' &&
      opts.cwd.protocol === 'file:'
    ) {
      cwdStr = fileURLToPath(new URL(opts.cwd.href));
    } else if (Buffer.isBuffer(opts.cwd)) {
      cwdStr = opts.cwd.toString('utf8');
    } else if (typeof opts.cwd === 'string') {
      cwdStr = opts.cwd;
    } else {
      throw invalidArgType('options.cwd', ['string', 'Buffer', 'URL'], opts.cwd);
    }
    validateNullFreeString(cwdStr, 'options.cwd');
    cwd = path.resolve(inherited.cwd, cwdStr);
  }

  let effectiveFile = file;
  let effectiveArgs = stringArgs;
  if (opts.shell) {
    if (typeof opts.shell === 'string') {
      validateNullFreeString(opts.shell, 'options.shell');
      effectiveFile = opts.shell;
    } else {
      effectiveFile = '/bin/sh';
    }
    effectiveArgs = ['-c', [file, ...stringArgs].join(' ')];
  }

  const suppliedEnv = opts.env ?? inherited.env;
  if (!record(suppliedEnv)) {
    throw fault('EINVAL', 'Invalid child cwd or environment');
  }
  const env: Record<string, string> = {};
  for (const key of Object.keys(suppliedEnv)) {
    const value = suppliedEnv[key];
    if (value !== undefined) {
      validateNullFreeString(key, `options.env['${key}']`);
      const coerced = String(value);
      validateNullFreeString(coerced, `options.env['${key}']`);
      env[key] = coerced;
    }
  }

  return {
    spec: {
      originalFile: effectiveFile,
      spawnargs: effectiveArgs,
      effectiveFile,
      effectiveArgs,
      cwd,
      env,
      stdio: opts.stdio,
      timeout,
      killSignal,
    },
    rawOptions: opts,
  };
}

export type ResolvedTarget =
  | { ok: true; command: 'node' | 'sh'; args: string[] }
  | { ok: false; code: 'ENOENT' | 'EACCES'; errno: -2 | -13 };

export function resolveSpawnTarget(
  effectiveFile: string,
  effectiveArgs: string[],
  cwd: string,
  env: Record<string, string>,
  fs: ReturnType<typeof createFs>,
): ResolvedTarget {
  if (effectiveFile === 'node' || effectiveFile === '/bin/node') {
    if (effectiveArgs.length === 0) {
      throw fault('ENOSYS', 'Child spawn requires a Node entry file');
    }
    return { ok: true, command: 'node', args: effectiveArgs };
  }
  if (effectiveFile === 'sh' || effectiveFile === '/bin/sh') {
    if (effectiveArgs.length === 0) {
      throw fault('ENOSYS', 'Child spawn requires shell arguments');
    }
    return { ok: true, command: 'sh', args: effectiveArgs };
  }

  const searchPath = typeof env.PATH === 'string' ? env.PATH : '/bin';
  const candidates = effectiveFile.includes('/')
    ? [path.resolve(cwd, effectiveFile)]
    : searchPath.split(':').map((dir) => path.resolve(cwd, dir || '.', effectiveFile));

  let denied = false;
  for (const candidate of candidates) {
    if (fs.statSync) {
      try {
        const stat = fs.statSync(candidate);
        if (record(stat) && typeof stat.isFile === 'function' && stat.isFile()) {
          if (isWasmBinary(fs, candidate)) {
            return { ok: true, command: 'node', args: [candidate, ...effectiveArgs] };
          }
          if (fs.accessSync) {
            try {
              fs.accessSync(candidate, 1);
            } catch (err) {
              if (!record(err) || err.code !== 'EACCES') throw err;
              denied = true;
              continue;
            }
          }
          if (fs.readFileSync) {
            const source = fs.readFileSync(candidate, 'utf8');
            if (typeof source === 'string') {
              const header = source.split('\n', 1)[0]?.trim();
              if (header === '#!/usr/bin/env node' || header === '#!/bin/node') {
                return { ok: true, command: 'node', args: [candidate, ...effectiveArgs] };
              }
            }
          }
          throw fault('ENOSYS', `Unsupported executable interpreter: ${candidate}`);
        }
        if (record(stat) && typeof stat.isDirectory === 'function' && stat.isDirectory()) {
          denied = true;
          continue;
        }
      } catch (err) {
        if (!record(err) || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) throw err;
      }
    }
    if (candidate === '/bin/node') {
      if (effectiveArgs.length === 0) {
        throw fault('ENOSYS', 'Child spawn requires a Node entry file');
      }
      return { ok: true, command: 'node', args: effectiveArgs };
    }
    if (candidate === '/bin/sh') {
      if (effectiveArgs.length === 0) {
        throw fault('ENOSYS', 'Child spawn requires shell arguments');
      }
      return { ok: true, command: 'sh', args: effectiveArgs };
    }
  }

  return denied
    ? { ok: false, code: 'EACCES', errno: -13 }
    : { ok: false, code: 'ENOENT', errno: -2 };
}

export function makeSpawnErrnoError(
  syscallPrefix: string,
  code: 'ENOENT' | 'EACCES' | 'ETIMEDOUT' | 'ENOBUFS',
  errno: number,
  file: string,
  spawnargs: string[],
): Error {
  const syscall = `${syscallPrefix} ${file}`;
  return Object.assign(new Error(`${syscall} ${code}`), {
    errno,
    code,
    syscall,
    path: file,
    spawnargs: Array.from(spawnargs),
  });
}

export type PrepareSyncChild = (
  entryPath: string,
  preloads: string[],
  cwd: string,
) => Promise<void>;

export function createChildProcess(
  defaults: () => { cwd: string; env: Record<string, unknown>; execArgv: string[] },
  retain: () => void,
  release: () => void,
  inheritedOutput: (stream: 'stdout' | 'stderr', bytes: Uint8Array) => void,
  inheritedPipes: OutputPipes,
  prepareStdio: (bindings: StdioBindings) => { bindings: StdioBindings; release: () => void },
  fs: ReturnType<typeof createFs>,
  onPrepareSync?: (prepare: PrepareSyncChild) => void,
) {
  let syncHelper: Worker | null = null;
  let syncHelperReady: Promise<void> | null = null;

  const mayUseSyncChild = (entryPath: string, preloads: string[], cwd: string): boolean => {
    if (preloads.some((preload) => !preload.startsWith('.') && !preload.startsWith('/'))) {
      return true;
    }
    const canonicalizeFile = (file: string): string | null => {
      if (!fs.realpathSync) return null;
      try {
        const real = fs.realpathSync(file);
        return typeof real === 'string' ? real : null;
      } catch {
        return null;
      }
    };
    const resolveLocalFile = (baseDir: string, spec: string): string | null => {
      const candidate = path.resolve(baseDir, spec);
      for (const file of [candidate, `${candidate}.js`, `${candidate}.cjs`, `${candidate}.mjs`]) {
        try {
          const st = fs.statSync(file);
          if (record(st) && typeof st.isFile === 'function' && st.isFile()) {
            return canonicalizeFile(file);
          }
        } catch {
          // Continue probing extensions.
        }
      }
      try {
        const dirSt = fs.statSync(candidate);
        if (record(dirSt) && typeof dirSt.isDirectory === 'function' && dirSt.isDirectory()) {
          // Directory packages with package.json ("main" / "exports") are treated
          // conservatively as sync-capable rather than duplicating full CJS/ESM resolution.
          try {
            const pkgSt = fs.statSync(path.join(candidate, 'package.json'));
            if (record(pkgSt) && typeof pkgSt.isFile === 'function' && pkgSt.isFile()) {
              return null;
            }
          } catch {
            // No package.json in directory; probe index files below.
          }
          for (const indexName of ['index.js', 'index.cjs', 'index.mjs']) {
            const indexFile = path.join(candidate, indexName);
            try {
              const idxSt = fs.statSync(indexFile);
              if (record(idxSt) && typeof idxSt.isFile === 'function' && idxSt.isFile()) {
                return canonicalizeFile(indexFile);
              }
            } catch {
              // Continue probing index extensions.
            }
          }
        }
      } catch {
        // Directory does not exist.
      }
      return null;
    };

    const queue: string[] = [];
    for (const preload of preloads) {
      const resolvedPreload = resolveLocalFile(cwd, preload);
      if (!resolvedPreload) return true;
      queue.push(resolvedPreload);
    }
    const rootFile = resolveLocalFile(cwd, entryPath);
    if (!rootFile) return true;
    queue.push(rootFile);

    const visited = new Set<string>();
    const dynamicCallPattern =
      /\b(?:require|import|getBuiltinModule)\s*\(\s*(?!['"][^'"]+['"]\s*\))/;
    const dynamicEvalPattern = /\b(?:eval|Function|vm|createRequire|_load|_compile|Reflect)\b/;
    const computedProcessPattern = /\bprocess\s*\[/;
    const specPattern =
      /\b(?:require|import|getBuiltinModule)\s*\(\s*(['"])([^'"]+)\1\s*\)|\b(?:from|import)\s*(['"])([^'"]+)\3/g;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      if (visited.size >= 24) return true;
      visited.add(current);
      if (current.endsWith('.json') || current.endsWith('.node')) continue;

      let source: unknown;
      try {
        source = fs.readFileSync(current, 'utf8');
      } catch {
        return true;
      }
      if (typeof source !== 'string') return true;

      if (
        source.includes('child_process') ||
        source.includes('spawnSync') ||
        source.includes('execFileSync') ||
        source.includes('execSync') ||
        source.includes('getBuiltin') ||
        computedProcessPattern.test(source) ||
        dynamicEvalPattern.test(source) ||
        dynamicCallPattern.test(source) ||
        /\\[xu]/i.test(source)
      ) {
        return true;
      }

      for (const match of source.matchAll(specPattern)) {
        const spec = match[2] ?? match[4];
        if (!spec) continue;
        if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
          const next = resolveLocalFile(path.dirname(current), spec);
          if (!next) return true;
          if (!visited.has(next)) queue.push(next);
        } else if (spec.startsWith('#') || !isBuiltin(spec)) {
          return true;
        }
      }
    }
    return false;
  };

  // PlzDedicatedWorker in Chromium delivers DedicatedWorker::OnScriptLoadStarted on
  // this parent Worker's task runner before starting the nested Worker thread, so a
  // nested Worker cannot finish starting if constructed synchronously inside spawnSync
  // right before Atomics.wait. Pre-booting asynchronously when mayUseSyncChild holds—and
  // never calling worker.terminate() before Atomics.wait / self.close on process exit so
  // Blink's ContextDestroyed() tears it down synchronously—avoids both deadlocks and leaks.
  const prepareSyncHelper: PrepareSyncChild = (entryPath, preloads, cwd) => {
    if (syncHelperReady !== null) return syncHelperReady;
    if (typeof HostWorker !== 'function') return Promise.resolve();
    if (!mayUseSyncChild(entryPath, preloads, cwd)) return Promise.resolve();
    syncHelperReady = new Promise<void>((resolve, reject) => {
      let settled = false;
      const worker = new HostWorker(new URL('process.js', import.meta.url), { type: 'module' });
      const timer = hostSetTimeout(() => {
        if (settled) return;
        settled = true;
        worker.terminate();
        reject(fault('ETIMEDOUT', 'Sync child helper worker startup timed out'));
      }, 5000);
      worker.onmessage = (ev: MessageEvent<unknown>) => {
        if (settled) return;
        if (record(ev.data) && ev.data.type === 'sync-wait-ready' && ev.data.version === VERSION) {
          settled = true;
          hostClearTimeout(timer);
          syncHelper = worker;
          resolve();
        }
      };
      worker.onerror = (ev) => {
        if (settled) return;
        settled = true;
        hostClearTimeout(timer);
        worker.terminate();
        reject(fault('EASSET', ev.message || 'Sync child helper worker failed to start'));
      };
      worker.postMessage({ type: 'sync-wait-helper', version: VERSION });
    });
    return syncHelperReady;
  };

  onPrepareSync?.(prepareSyncHelper);

  const prepareStdioRoutes = (slots: readonly StdioSlot[]) => {
    // Acquire file references synchronously, before spawn returns to the guest.
    // A parent's own standard descriptor in its own slot is plain inheritance.
    const prepared = prepareStdio(
      slots.map((slot, index) =>
        slot === 'inherit' || slot === index ? 'inherit' : typeof slot === 'number' ? slot : null,
      ),
    );
    // A binding the kernel left as 'inherit' or as a standard descriptor number is
    // one of this process's own streams; a file-backed one came back as an alias.
    const inheritedStream = (index: 1 | 2): 'stdout' | 'stderr' | undefined => {
      const binding = prepared.bindings[index];
      if (binding === 'inherit') return index === 1 ? 'stdout' : 'stderr';
      return binding === 1 ? 'stdout' : binding === 2 ? 'stderr' : undefined;
    };
    const routes = { stdout: inheritedStream(1), stderr: inheritedStream(2) };
    if (
      prepared.bindings[0] === 1 ||
      prepared.bindings[0] === 2 ||
      prepared.bindings[1] === 0 ||
      prepared.bindings[2] === 0
    ) {
      prepared.release();
      throw fault(
        'ENOSYS',
        'Reading from an inherited output stream or writing to inherited input is unsupported',
      );
    }
    return { prepared, routes };
  };

  const spawnInternal = (
    command: unknown,
    args: unknown = [],
    options: unknown = {},
    ipcSerialization: 'json' | 'advanced' = 'json',
    execArgv: string[] = [],
  ) => {
    const { spec } = normalizeSpawnSpec(command, args, options, defaults);
    const resolved = resolveSpawnTarget(
      spec.effectiveFile,
      spec.effectiveArgs,
      spec.cwd,
      spec.env,
      fs,
    );
    // Node reads a falsy stdio as its default; fork and spawn share this normalization.
    const { slots, ipc: wantsIpc, entries } = normalizeStdio(spec.stdio || 'pipe', util.inspect);
    const shell = resolved.ok && resolved.command === 'sh';
    if (wantsIpc && shell) {
      throw fault('ENOSYS', 'An IPC channel is only supported for Node children');
    }
    const { prepared, routes } = prepareStdioRoutes(slots);
    const ignored = { stdout: slots[1] === 'ignore', stderr: slots[2] === 'ignore' };
    const ipcPorts = wantsIpc ? new MessageChannel() : undefined;
    const channel = new MessageChannel();
    let settled = false;
    let nextWrite = 0;
    const writes = new Map<number, (error?: Error | null) => void>();
    const sendInput = (bytes: Uint8Array | null, complete: (error?: Error | null) => void) => {
      const callback = captured(complete);
      if (settled) {
        callback(fault('EPIPE', 'Child exited'));
        return;
      }
      const id = ++nextWrite;
      writes.set(id, callback);
      try {
        channel.port1.postMessage({ type: 'stdin', version: VERSION, id, bytes });
      } catch (error) {
        writes.delete(id);
        callback(error instanceof Error ? error : fault('EIO', String(error)));
      }
    };
    const stdin =
      slots[0] === 'pipe'
        ? markHandleStream(
            new Writable({
              write(chunk: unknown, _encoding, callback) {
                if (!(chunk instanceof Uint8Array)) {
                  callback(fault('EINVAL', 'Invalid stdin bytes'));
                  return;
                }
                sendInput(chunk, callback);
              },
              final(callback) {
                sendInput(null, callback);
              },
            }),
          )
        : null;
    const outputPipes: OutputPipes = {
      stdout: routes.stdout ? inheritedPipes[routes.stdout] : new SharedArrayBuffer(4),
      stderr: routes.stderr ? inheritedPipes[routes.stderr] : new SharedArrayBuffer(4),
    };
    const reader = (name: 'stdout' | 'stderr') =>
      markHandleStream(
        new Readable({
          read() {},
          destroy(error, callback) {
            closeOutputPipe(outputPipes[name]);
            callback(error);
          },
        }),
      );
    const initialState: {
      pid: number | undefined;
      exitCode: number | null;
      signalCode: ExitSignal;
    } = {
      pid: undefined,
      exitCode: null,
      signalCode: null,
    };
    const child = Object.assign(new ChildProcess(), {
      ...initialState,
      killed: false,
      kill(signal: unknown = 'SIGTERM') {
        if (signal !== 'SIGTERM' && signal !== 'SIGINT' && signal !== 'SIGKILL')
          throw fault('ENOSYS', 'Only SIGTERM, SIGINT and SIGKILL are supported');
        if (settled) return false;
        channel.port1.postMessage({ type: 'kill', version: VERSION, signal });
        child.killed = true;
        return true;
      },
      stdout: slots[1] === 'pipe' ? reader('stdout') : null,
      stderr: slots[2] === 'pipe' ? reader('stderr') : null,
      stdin,
      connected: false,
    });
    Object.assign(child, {
      stdio: [
        child.stdin,
        child.stdout,
        child.stderr,
        ...Array.from({ length: entries - 3 }, () => null),
      ],
    });
    let relayed = 0;
    const ipc = ipcPorts
      ? attachIpc(child, ipcPorts.port1, retain, release, false, ipcSerialization, {
          relayed: () => relayed,
        })
      : undefined;
    let size = 0;
    let finished = false;
    let held = false;
    const references = new Set([
      'process',
      ...(child.stdout ? ['stdout'] : []),
      ...(stdin ? ['stdin'] : []),
      ...(child.stderr ? ['stderr'] : []),
    ]);
    const syncReferences = () => {
      const needed = !finished && references.size > 0;
      if (needed === held) return;
      held = needed;
      if (held) retain();
      else release();
    };
    Object.assign(child, {
      ref() {
        references.add('process');
        syncReferences();
      },
      unref() {
        references.delete('process');
        syncReferences();
      },
    });
    for (const [name, pipe] of [
      ['stdin', stdin],
      ['stdout', child.stdout],
      ['stderr', child.stderr],
    ] as const) {
      if (!pipe) continue;
      pipe.once('close', () => {
        references.delete(name);
        syncReferences();
      });
      Object.assign(pipe, {
        ref() {
          if (!pipe.destroyed) references.add(name);
          syncReferences();
          return pipe;
        },
        unref() {
          references.delete(name);
          syncReferences();
          return pipe;
        },
      });
    }
    syncReferences();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const dispose = () => {
      settled = true;
      if (timeoutHandle !== undefined) {
        hostClearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      prepared.release();
      ipc?.stop();
      channel.port1.close();
      for (const callback of writes.values()) callback(fault('EPIPE', 'Child exited'));
      writes.clear();
    };
    const finish = (code: number, error?: Error, signal: ExitSignal = null) => {
      if (settled) return;
      relayed = Number.POSITIVE_INFINITY;
      ipc?.advance();
      child.exitCode = signal ? null : code;
      child.signalCode = signal;
      dispose();
      const outputs = [
        ...(child.stdout ? [child.stdout] : []),
        ...(child.stderr ? [child.stderr] : []),
      ];
      let remaining = Math.max(1, outputs.length);
      const ended = () => {
        if (--remaining === 0) {
          try {
            child.emit('close', child.exitCode, signal);
          } finally {
            finished = true;
            syncReferences();
          }
        }
      };
      for (const output of outputs) {
        let outputSettled = false;
        const onOutputDone = () => {
          if (outputSettled) return;
          outputSettled = true;
          ended();
        };
        if (output.destroyed) {
          if (output.closed) hostQueueMicrotask(onOutputDone);
          else output.once('close', onOutputDone);
          continue;
        }
        output.once('end', onOutputDone);
        output.once('close', onOutputDone);
        output.push(null);
        output.resume();
      }
      if (outputs.length === 0) hostQueueMicrotask(ended);
      if (error) child.emit('error', error);
      else child.emit('exit', child.exitCode, signal);
    };

    if (!resolved.ok) {
      channel.port2.close();
      ipcPorts?.port2.close();
      prepared.release();
      const err = makeSpawnErrnoError(
        'spawn',
        resolved.code,
        resolved.errno,
        spec.originalFile,
        spec.spawnargs,
      );
      hostQueueMicrotask(
        captured(() => {
          stdin?.destroy();
          finish(resolved.errno, err, null);
        }),
      );
      return child;
    }

    channel.port1.onmessage = captured((event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!record(message) || message.version !== VERSION || settled) return;
      if (message.type === 'stdin-error' && typeof message.error === 'string') {
        stdin?.destroy(
          fault(typeof message.code === 'string' ? message.code : 'EIO', message.error),
        );
      } else if (message.type === 'stdin-ack' && typeof message.id === 'number') {
        const callback = writes.get(message.id);
        if (!callback) return;
        writes.delete(message.id);
        callback(
          typeof message.error === 'string'
            ? fault(typeof message.code === 'string' ? message.code : 'EIO', message.error)
            : undefined,
        );
      } else if (message.type === 'spawned' && typeof message.pid === 'number') {
        prepared.release();
        child.pid = message.pid;
        child.emit('spawn');
      } else if (
        message.type === 'output' &&
        (message.stream === 'stdout' || message.stream === 'stderr') &&
        message.bytes instanceof Uint8Array
      ) {
        relayed++;
        const route = routes[message.stream];
        if (!ignored[message.stream]) {
          if (route) inheritedOutput(route, message.bytes);
          else {
            size += message.bytes.byteLength;
            if (size > resourceLimits().child.outputBytes) {
              channel.port1.postMessage({ type: 'kill', version: VERSION });
              finish(1, fault('E2BIG', 'Child output exceeds limit'));
              return;
            }
            child[message.stream]?.push(Buffer.from(message.bytes));
          }
        }
        ipc?.advance();
      } else if (message.type === 'exit' && typeof message.code === 'number') {
        if (
          message.signal === undefined ||
          message.signal === 'SIGTERM' ||
          message.signal === 'SIGINT' ||
          message.signal === 'SIGPIPE' ||
          message.signal === 'SIGKILL' ||
          message.signal === 'SIGABRT'
        )
          finish(message.code, undefined, message.signal ?? null);
      } else if (message.type === 'error' && typeof message.message === 'string') {
        finish(1, fault(typeof message.code === 'string' ? message.code : 'EIO', message.message));
      }
    });
    try {
      self.postMessage(
        {
          type: 'spawn-child',
          version: VERSION,
          command: resolved.command,
          stdinPipe: slots[0] === 'pipe',
          stdinInherit: prepared.bindings[0] === 'inherit',
          outputPipes,
          stdio: prepared.bindings,
          args: resolved.args,
          execArgv,
          options: { cwd: spec.cwd, env: spec.env },
          port: channel.port2,
          ipcPort: ipcPorts?.port2,
          ipcSerialization,
        },
        [channel.port2, ...(ipcPorts ? [ipcPorts.port2] : [])],
      );
    } catch (error) {
      dispose();
      channel.port2.close();
      ipcPorts?.port2.close();
      stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      finished = true;
      syncReferences();
      throw error;
    }
    if (spec.timeout > 0) {
      timeoutHandle = hostSetTimeout(
        captured(() => {
          timeoutHandle = undefined;
          if (!settled) {
            child.kill(spec.killSignal);
          }
        }),
        spec.timeout,
      );
    }
    return child;
  };

  const spawn = (command: unknown, args?: unknown, options?: unknown) =>
    spawnInternal(command, args, options);

  function normalizeExecFileArgs(
    file: unknown,
    args?: unknown,
    options?: unknown,
    callback?: unknown,
  ): {
    file: unknown;
    args: unknown[];
    options: Record<string, unknown>;
    callback:
      | ((error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void)
      | null;
  } {
    let parsedArgs: unknown[] | null = null;
    let parsedOpts: unknown = options;
    let parsedCb: unknown = callback;

    if (Array.isArray(args)) {
      parsedArgs = Array.from(args);
    } else if (args != null && typeof args === 'object') {
      parsedCb = options;
      parsedOpts = args;
    } else if (typeof args === 'function') {
      parsedCb = args;
      parsedOpts = null;
    }

    let optsObj: Record<string, unknown> = {};
    if (typeof parsedOpts === 'function') {
      parsedCb = parsedOpts;
    } else if (parsedOpts != null) {
      validateObject(parsedOpts, 'options');
      optsObj = { ...parsedOpts };
    }

    if (parsedCb != null && typeof parsedCb !== 'function') {
      throw invalidArgType('callback', 'Function', parsedCb);
    }

    if (optsObj.argv0 != null) {
      if (typeof optsObj.argv0 !== 'string') {
        throw invalidArgType('options.argv0', 'string', optsObj.argv0);
      }
      validateNullFreeString(optsObj.argv0, 'options.argv0');
    }

    return {
      file,
      args: parsedArgs ?? [],
      options: optsObj,
      // Invariant: validated above as either null/undefined or a function.
      callback: (parsedCb ?? null) as
        | ((error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void)
        | null,
    };
  }

  function execFile(file: unknown, args?: unknown, options?: unknown, callback?: unknown) {
    const normalized = normalizeExecFileArgs(file, args, options, callback);
    const opts: Record<string, unknown> = {
      encoding: 'utf8',
      timeout: 0,
      maxBuffer: MAX_BUFFER,
      killSignal: 'SIGTERM',
      cwd: undefined,
      env: undefined,
      shell: false,
      ...normalized.options,
    };

    validateTimeout(opts.timeout);
    validateMaxBuffer(opts.maxBuffer);
    const killSignal = sanitizeKillSignal(opts.killSignal);
    const maxBuffer = typeof opts.maxBuffer === 'number' ? opts.maxBuffer : MAX_BUFFER;
    const timeout = typeof opts.timeout === 'number' ? opts.timeout : 0;

    for (const key of Object.keys(normalized.options)) {
      if (!ALLOWED_SPAWN_OPTIONS.has(key) && key !== 'encoding' && key !== 'maxBuffer') {
        throw fault('ENOSYS', 'Unsupported child spawn option');
      }
    }

    const child = spawnInternal(normalized.file, normalized.args, {
      cwd: opts.cwd,
      env: opts.env,
      gid: opts.gid,
      uid: opts.uid,
      detached: opts.detached,
      signal: opts.signal,
      shell: opts.shell,
      argv0: opts.argv0,
      windowsHide: Boolean(opts.windowsHide),
      windowsVerbatimArguments: Boolean(opts.windowsVerbatimArguments),
    });

    const strEncoding =
      typeof opts.encoding === 'string' &&
      opts.encoding !== 'buffer' &&
      Buffer.isEncoding(opts.encoding)
        ? opts.encoding
        : null;

    const stdoutChunks: Array<string | Buffer> = [];
    const stderrChunks: Array<string | Buffer> = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let killed = false;
    let exited = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let ex: Error | null = null;
    let cmd = String(normalized.file);

    const userCb = normalized.callback ? captured(normalized.callback) : null;

    function exitHandler(code?: number | null, signal?: ExitSignal) {
      if (exited) return;
      exited = true;

      if (timeoutId !== null) {
        hostClearTimeout(timeoutId);
        timeoutId = null;
      }

      if (!userCb) return;

      const stdout = strEncoding
        ? stdoutChunks.join('')
        : Buffer.concat(stdoutChunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c)));
      const stderr = strEncoding
        ? stderrChunks.join('')
        : Buffer.concat(stderrChunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c)));

      if (!ex && code === 0 && (signal === null || signal === undefined)) {
        userCb(null, stdout, stderr);
        return;
      }

      if (normalized.args.length > 0) {
        cmd += ` ${normalized.args.map(String).join(' ')}`;
      }

      const finalErr =
        ex ??
        Object.assign(
          new Error(
            `Command failed: ${cmd}\n${typeof stderr === 'string' ? stderr : stderr.toString('utf8')}`,
          ),
          {
            code: code ?? null,
            killed: child.killed || killed,
            signal: signal ?? null,
          },
        );
      Object.assign(finalErr, { cmd });
      userCb(finalErr, stdout, stderr);
    }

    function errorHandler(err: Error) {
      ex = err;
      child.stdout?.destroy();
      child.stderr?.destroy();
      exitHandler(null, null);
    }

    function killChild() {
      child.stdout?.destroy();
      child.stderr?.destroy();
      killed = true;
      try {
        child.kill(killSignal);
      } catch (err) {
        ex = err instanceof Error ? err : new Error(String(err));
        exitHandler(null, null);
      }
    }

    if (timeout > 0) {
      timeoutId = hostSetTimeout(() => {
        timeoutId = null;
        killChild();
      }, timeout);
    }

    if (child.stdout) {
      if (strEncoding) child.stdout.setEncoding(strEncoding);
      child.stdout.on('data', (chunk: string | Uint8Array) => {
        if (maxBuffer === Number.POSITIVE_INFINITY) {
          stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
          return;
        }
        const length =
          typeof chunk === 'string'
            ? Buffer.byteLength(chunk, strEncoding ?? 'utf8')
            : chunk.byteLength;
        stdoutLen += length;
        if (stdoutLen > maxBuffer) {
          const keep = Math.max(0, maxBuffer - (stdoutLen - length));
          if (typeof chunk === 'string') {
            stdoutChunks.push(
              Buffer.from(chunk, strEncoding ?? 'utf8')
                .subarray(0, keep)
                .toString(strEncoding ?? 'utf8'),
            );
          } else {
            stdoutChunks.push(Buffer.from(chunk.subarray(0, keep)));
          }
          ex = nodeError(
            RangeError,
            'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            'stdout maxBuffer length exceeded',
          );
          killChild();
        } else {
          stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
        }
      });
    }

    if (child.stderr) {
      if (strEncoding) child.stderr.setEncoding(strEncoding);
      child.stderr.on('data', (chunk: string | Uint8Array) => {
        if (maxBuffer === Number.POSITIVE_INFINITY) {
          stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
          return;
        }
        const length =
          typeof chunk === 'string'
            ? Buffer.byteLength(chunk, strEncoding ?? 'utf8')
            : chunk.byteLength;
        stderrLen += length;
        if (stderrLen > maxBuffer) {
          const keep = Math.max(0, maxBuffer - (stderrLen - length));
          if (typeof chunk === 'string') {
            stderrChunks.push(
              Buffer.from(chunk, strEncoding ?? 'utf8')
                .subarray(0, keep)
                .toString(strEncoding ?? 'utf8'),
            );
          } else {
            stderrChunks.push(Buffer.from(chunk.subarray(0, keep)));
          }
          ex = nodeError(
            RangeError,
            'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            'stderr maxBuffer length exceeded',
          );
          killChild();
        } else {
          stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
        }
      });
    }

    child.addListener('close', exitHandler);
    child.addListener('error', errorHandler);
    return child;
  }

  function normalizeExecArgs(
    command: unknown,
    options?: unknown,
    callback?: unknown,
  ): { file: string; options: Record<string, unknown>; callback: unknown } {
    if (typeof command !== 'string') throw invalidArgType('command', 'string', command);
    validateNullFreeString(command, 'command');
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') {
      cb = opts;
      opts = undefined;
    }
    const copied: Record<string, unknown> = record(opts) ? { ...opts } : {};
    copied.shell = typeof copied.shell === 'string' ? copied.shell : true;
    return { file: command, options: copied, callback: cb };
  }

  function exec(command: unknown, options?: unknown, callback?: unknown) {
    const normalized = normalizeExecArgs(command, options, callback);
    return execFile(normalized.file, normalized.options, normalized.callback);
  }

  function attachCustomPromisify(
    fn: (...args: unknown[]) => ReturnType<typeof spawnInternal>,
    fnName: string,
  ): void {
    const promisified = (...callArgs: unknown[]) => {
      let resolvePromise!: (value: { stdout: string | Buffer; stderr: string | Buffer }) => void;
      let rejectPromise!: (reason: unknown) => void;
      const promise = new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>(
        (resolve, reject) => {
          resolvePromise = resolve;
          rejectPromise = reject;
        },
      );
      const child = fn(
        ...callArgs,
        (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
          if (err !== null) {
            Object.assign(err, { stdout, stderr });
            rejectPromise(err);
          } else {
            resolvePromise({ stdout, stderr });
          }
        },
      );
      return Object.assign(promise, { child });
    };
    Object.defineProperty(promisified, 'name', { value: fnName, configurable: true });
    Object.defineProperty(fn, kCustomPromisifiedSymbol, {
      enumerable: false,
      configurable: true,
      value: promisified,
    });
  }

  attachCustomPromisify(execFile, 'execFile');
  attachCustomPromisify(exec, 'exec');

  function normalizeSyncStdio(value: unknown): {
    slots: [StdioSlot, StdioSlot, StdioSlot];
    stdioInput: string | ArrayBufferView | undefined;
  } {
    const invalid = (item: unknown) => invalidArgValue('stdio', item);
    let stdio: unknown[];
    if (typeof value === 'string') {
      if (value === 'ignore' || value === 'pipe' || value === 'overlapped') {
        stdio = [value, value, value];
      } else if (value === 'inherit') {
        stdio = [0, 1, 2];
      } else {
        throw invalid(value);
      }
    } else if (Array.isArray(value)) {
      stdio = value;
    } else {
      throw invalid(value);
    }

    const entries = Math.max(3, stdio.length);
    const slots: [StdioSlot, StdioSlot, StdioSlot] = ['pipe', 'pipe', 'pipe'];
    let stdioInput: string | ArrayBufferView | undefined;
    let unsupported: string | undefined;

    for (let index = 0; index < entries; index++) {
      const raw: unknown = stdio[index];
      const entry = raw ?? (index < 3 ? 'pipe' : 'ignore');
      let slot: StdioSlot;
      if (entry === 'ignore' || entry === 'inherit') {
        slot = entry;
      } else if (entry === 'pipe' || entry === 'overlapped') {
        slot = 'pipe';
      } else if (typeof entry === 'number' && entry < 0) {
        slot = 'pipe';
      } else if (entry === 'ipc') {
        throw nodeError(Error, 'ERR_IPC_SYNC_FORK', 'IPC cannot be used with synchronous forks');
      } else if (typeof entry === 'number' || (record(entry) && typeof entry.fd === 'number')) {
        const fd = typeof entry === 'number' ? entry : entry.fd;
        if (typeof fd !== 'number' || !Number.isInteger(fd) || fd > 0x7fffffff) {
          throw fault('EINVAL', 'Child stdio descriptors must be 32-bit integers');
        }
        if (fd < 0) throw fault('EINVAL', 'spawn EINVAL');
        slot = fd;
      } else if (typeof entry === 'string' || ArrayBuffer.isView(entry)) {
        if (index === 0) {
          stdioInput = entry;
          slot = 'pipe';
        } else {
          unsupported ??= 'Input buffers on non-stdin descriptors are unsupported';
          slot = 'ignore';
        }
      } else {
        throw invalid(entry);
      }
      if (index < 3) slots[index] = slot;
      else if (slot !== 'ignore') {
        unsupported ??= 'Child descriptors beyond the three standard streams are unsupported';
      }
    }
    if (unsupported !== undefined) throw fault('ENOSYS', unsupported);
    return { slots, stdioInput };
  }

  interface SpawnSyncResult {
    error?: Error;
    status: number | null;
    signal: ExitSignal;
    output: [null, Buffer | string | null, Buffer | string | null] | null;
    pid: number;
    stdout: Buffer | string | null | undefined;
    stderr: Buffer | string | null | undefined;
  }

  function spawnSync(command: unknown, args: unknown = [], options: unknown = {}): SpawnSyncResult {
    const { spec, rawOptions } = normalizeSpawnSpec(
      command,
      args,
      options,
      defaults,
      SYNC_EXTRA_OPTIONS,
    );
    const maxBufferRaw = rawOptions.maxBuffer === undefined ? MAX_BUFFER : rawOptions.maxBuffer;
    validateMaxBuffer(maxBufferRaw);
    const maxBuffer = typeof maxBufferRaw === 'number' ? maxBufferRaw : MAX_BUFFER;

    const { slots, stdioInput } = normalizeSyncStdio(spec.stdio || 'pipe');

    let inputBytes: Uint8Array | null = null;
    const rawInput = rawOptions.input ? rawOptions.input : stdioInput;
    if (rawInput != null) {
      if (ArrayBuffer.isView(rawInput)) {
        inputBytes = new Uint8Array(
          rawInput.buffer,
          rawInput.byteOffset,
          rawInput.byteLength,
        ).slice();
      } else if (typeof rawInput === 'string') {
        const enc =
          typeof rawOptions.encoding === 'string' &&
          rawOptions.encoding !== 'buffer' &&
          Buffer.isEncoding(rawOptions.encoding)
            ? rawOptions.encoding
            : 'utf8';
        inputBytes = new Uint8Array(Buffer.from(rawInput, enc));
      } else {
        throw invalidArgType(
          'options.stdio[0]',
          ['Buffer', 'TypedArray', 'DataView', 'string'],
          rawInput,
        );
      }
    }

    const resolved = resolveSpawnTarget(
      spec.effectiveFile,
      spec.effectiveArgs,
      spec.cwd,
      spec.env,
      fs,
    );
    if (!resolved.ok) {
      return {
        error: makeSpawnErrnoError(
          'spawnSync',
          resolved.code,
          resolved.errno,
          spec.originalFile,
          spec.spawnargs,
        ),
        status: null,
        signal: null,
        output: null,
        pid: 0,
        stdout: undefined,
        stderr: undefined,
      };
    }

    if (syncHelper === null) {
      throw fault('EIO', 'Sync child helper worker is unavailable');
    }
    const helper = syncHelper;
    const { prepared, routes } = prepareStdioRoutes(slots);

    const outputPipes: OutputPipes = {
      stdout: routes.stdout ? inheritedPipes[routes.stdout] : new SharedArrayBuffer(4),
      stderr: routes.stderr ? inheritedPipes[routes.stderr] : new SharedArrayBuffer(4),
    };
    const channel = new MessageChannel();
    const hasInputBytes = slots[0] === 'pipe' && inputBytes !== null && inputBytes.byteLength > 0;
    const sab = new SharedArrayBuffer(SYNC_HEADER_BYTES + SYNC_DEFAULT_PAYLOAD_BYTES);
    const control = new Int32Array(sab, 0, 16);
    const payload = new Uint8Array(sab, SYNC_HEADER_BYTES);

    let childSpawnPosted = false;
    let helperRunPosted = false;
    try {
      self.postMessage(
        {
          type: 'spawn-child',
          version: VERSION,
          command: resolved.command,
          stdinPipe: hasInputBytes,
          stdinInherit: prepared.bindings[0] === 'inherit',
          outputPipes,
          stdio: prepared.bindings,
          args: resolved.args,
          execArgv: [],
          options: { cwd: spec.cwd, env: spec.env },
          port: channel.port2,
          ipcPort: undefined,
          ipcSerialization: 'json',
        },
        [channel.port2],
      );
      childSpawnPosted = true;

      const transferList: Transferable[] = [channel.port1];
      if (
        hasInputBytes &&
        inputBytes !== null &&
        !(inputBytes.buffer instanceof SharedArrayBuffer)
      ) {
        transferList.push(inputBytes.buffer);
      }
      helper.postMessage(
        {
          type: 'run',
          port: channel.port1,
          sab,
          version: VERSION,
          timeout: spec.timeout,
          killSignal: spec.killSignal,
          maxBuffer,
          ignoredStdout: slots[1] === 'ignore',
          ignoredStderr: slots[2] === 'ignore',
          routeStdout: routes.stdout ?? null,
          routeStderr: routes.stderr ?? null,
          pipeStdout: slots[1] === 'pipe',
          pipeStderr: slots[2] === 'pipe',
          inputBytes: hasInputBytes ? inputBytes : null,
        },
        transferList,
      );
      helperRunPosted = true;

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      for (;;) {
        Atomics.wait(control, SYNC_CTRL_OP, SYNC_OP_IDLE);
        const op = Atomics.load(control, SYNC_CTRL_OP);
        if (op === SYNC_OP_IDLE) continue;
        if (op === SYNC_OP_DONE) break;

        const len = Atomics.load(control, SYNC_CTRL_LEN_OR_PID);
        if (len < 0 || len > payload.byteLength) {
          throw fault('EPROTO', 'Invalid sync child packet length');
        }
        const copy = Buffer.from(payload.slice(0, len));
        Atomics.store(control, SYNC_CTRL_OP, SYNC_OP_IDLE);
        Atomics.store(control, SYNC_CTRL_ACK, 1);
        Atomics.notify(control, SYNC_CTRL_ACK, 1);

        if (op === SYNC_OP_PIPE_STDOUT) {
          stdoutChunks.push(copy);
        } else if (op === SYNC_OP_PIPE_STDERR) {
          stderrChunks.push(copy);
        } else if (op === SYNC_OP_INHERIT_STDOUT) {
          inheritedOutput('stdout', copy);
        } else if (op === SYNC_OP_INHERIT_STDERR) {
          inheritedOutput('stderr', copy);
        } else {
          throw fault('EPROTO', `Unknown sync child packet opcode: ${op}`);
        }
      }

      const pid = Atomics.load(control, SYNC_CTRL_LEN_OR_PID);
      const hasStatus = Atomics.load(control, SYNC_CTRL_HAS_STATUS) === 1;
      const status = hasStatus ? Atomics.load(control, SYNC_CTRL_STATUS) : null;
      const signal = SIGNAL_FROM_CODE[Atomics.load(control, SYNC_CTRL_SIGNAL)] ?? null;
      const errorKind = Atomics.load(control, SYNC_CTRL_ERR_KIND);

      let syncError: Error | undefined;
      if (errorKind === SYNC_ERR_NONE) {
        syncError = undefined;
      } else if (errorKind === SYNC_ERR_TIMEOUT) {
        syncError = makeSpawnErrnoError(
          'spawnSync',
          'ETIMEDOUT',
          -110,
          spec.originalFile,
          spec.spawnargs,
        );
      } else if (errorKind === SYNC_ERR_MAXBUFFER) {
        syncError = makeSpawnErrnoError(
          'spawnSync',
          'ENOBUFS',
          -105,
          spec.originalFile,
          spec.spawnargs,
        );
      } else if (errorKind === SYNC_ERR_FAULT) {
        const errLen = Atomics.load(control, SYNC_CTRL_ERR_LEN);
        if (errLen < 0 || errLen > payload.byteLength) {
          throw fault('EPROTO', 'Invalid sync child error length');
        }
        const rawErr = new TextDecoder().decode(payload.slice(0, errLen));
        const nl = rawErr.indexOf('\n');
        const errCode = nl >= 0 ? rawErr.slice(0, nl) : 'EIO';
        const errMsg = nl >= 0 ? rawErr.slice(nl + 1) : rawErr;
        syncError = fault(errCode, errMsg);
      } else {
        throw fault('EPROTO', `Unknown sync child error kind: ${errorKind}`);
      }

      const out1: Buffer | null = slots[1] === 'pipe' ? Buffer.concat(stdoutChunks) : null;
      const out2: Buffer | null = slots[2] === 'pipe' ? Buffer.concat(stderrChunks) : null;
      const output: [null, Buffer | string | null, Buffer | string | null] = [null, out1, out2];

      if (rawOptions.encoding && rawOptions.encoding !== 'buffer') {
        const enc = String(rawOptions.encoding);
        if (!Buffer.isEncoding(enc)) {
          if ((out1 && out1.length > 0) || (out2 && out2.length > 0)) {
            throw nodeError(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${enc}`);
          }
          if (out1 !== null) output[1] = '';
          if (out2 !== null) output[2] = '';
        } else {
          if (out1 !== null) output[1] = out1.toString(enc);
          if (out2 !== null) output[2] = out2.toString(enc);
        }
      }

      if (syncError !== undefined) {
        return {
          error: syncError,
          status,
          signal,
          output,
          pid,
          stdout: output[1],
          stderr: output[2],
        };
      }
      return {
        status,
        signal,
        output,
        pid,
        stdout: output[1],
        stderr: output[2],
      };
    } finally {
      prepared.release();
      if (childSpawnPosted && !helperRunPosted) {
        try {
          channel.port1.postMessage({ type: 'kill', version: VERSION, signal: 'SIGKILL' });
        } catch {
          // Port may already be closed or transferred.
        }
      }
      try {
        channel.port1.close();
      } catch {
        // Port may already be transferred.
      }
      try {
        channel.port2.close();
      } catch {
        // Port may already be transferred.
      }
    }
  }

  function writeInheritedStderr(stderrVal: Buffer | string | null | undefined): void {
    if (!stderrVal) return;
    const bytes = typeof stderrVal === 'string' ? Buffer.from(stderrVal) : stderrVal;
    if (bytes.byteLength === 0) return;
    if (fs.writeSync) {
      fs.writeSync(2, bytes);
    } else {
      inheritedOutput('stderr', bytes);
    }
  }

  function checkExecSyncError(
    ret: SpawnSyncResult,
    errArgs: string[],
    cmd?: string,
  ): Error | undefined {
    if (ret.error) {
      return Object.assign(ret.error, ret);
    }
    if (ret.status !== 0) {
      let msg = `Command failed: ${cmd ?? errArgs.join(' ')}`;
      if (ret.stderr && ret.stderr.length > 0) {
        msg += `\n${typeof ret.stderr === 'string' ? ret.stderr : ret.stderr.toString('utf8')}`;
      }
      return Object.assign(new Error(msg), ret);
    }
    return undefined;
  }

  function execFileSync(
    file: unknown,
    args?: unknown,
    options?: unknown,
  ): Buffer | string | null | undefined {
    const normalized = normalizeExecFileArgs(file, args, options);
    const inheritStderr = !normalized.options.stdio;
    const ret = spawnSync(normalized.file, normalized.args, normalized.options);
    if (inheritStderr) {
      writeInheritedStderr(ret.stderr);
    }
    const errArgs = [
      typeof normalized.options.argv0 === 'string'
        ? normalized.options.argv0
        : String(normalized.file),
      ...normalized.args.map(String),
    ];
    const err = checkExecSyncError(ret, errArgs);
    if (err) throw err;
    return ret.stdout;
  }

  function execSync(command: unknown, options?: unknown): Buffer | string | null | undefined {
    const normalized = normalizeExecArgs(command, options);
    const inheritStderr = !normalized.options.stdio;
    const ret = spawnSync(normalized.file, normalized.options);
    if (inheritStderr) {
      writeInheritedStderr(ret.stderr);
    }
    const err = checkExecSyncError(ret, [], normalized.file);
    if (err) throw err;
    return ret.stdout;
  }

  return {
    ChildProcess,
    spawn,
    spawnSync,
    execFile,
    execFileSync,
    exec,
    execSync,
    fork(modulePath: unknown, args: unknown = [], options: unknown = {}) {
      if (!Array.isArray(args)) {
        options = args;
        args = [];
      }
      if (typeof modulePath !== 'string' || !modulePath || !record(options) || !Array.isArray(args))
        throw fault('EINVAL', 'Invalid fork arguments');
      if (
        Object.keys(options).some(
          (key) => !['cwd', 'env', 'silent', 'stdio', 'serialization', 'execArgv'].includes(key),
        )
      )
        throw fault('ENOSYS', 'Unsupported fork option');
      if (
        options.serialization !== undefined &&
        options.serialization !== 'json' &&
        options.serialization !== 'advanced'
      )
        throw fault('ENOSYS', 'Unsupported fork serialization');
      const stdio = forkStdio(options.stdio, options.silent, util.inspect);
      const execArgv = parseExecArgv(
        options.execArgv === undefined ? defaults().execArgv : options.execArgv,
      ).argv;
      return spawnInternal(
        'node',
        [modulePath, ...args],
        { cwd: options.cwd, env: options.env, stdio },
        options.serialization ?? 'json',
        execArgv,
      );
    },
  };
}
