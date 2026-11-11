import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import { Readable } from 'readable-stream/lib/stream.js';
import { captured } from './context-hook';
import { parseExecArgv } from './exec-argv';
import { nodeError } from './node-errors';
import { VERSION, fault, record } from './protocol';
import { resourceLimits as runtimePolicyLimits } from './resource-policy';
import { snapshotThreadValue } from './thread-clone';
import { createThreadPort, threadValueSize } from './thread-port';
import {
  NativeMessageChannel,
  ensureChannelPrototypes,
  isMarkedAsUntransferable,
  markAsUncloneable,
  markAsUntransferable,
  moveMessagePortToContext,
  receiveMessageOnPort,
} from './worker-threads-marks';

const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');

const DEFAULT_WORKER_RESOURCE_LIMITS = {
  maxYoungGenerationSizeMb: 48,
  maxOldGenerationSizeMb: 2048,
  codeRangeSizeMb: 0,
  stackSizeMb: 4,
};

interface UtilizationSnapshot {
  idle: number;
  active: number;
  utilization: number;
}

function isUtilizationLike(v: unknown): v is { idle: number; active: number } {
  return record(v) && typeof v.idle === 'number' && typeof v.active === 'number';
}

function computeWorkerElu(startMs: number, util1?: unknown, util2?: unknown): UtilizationSnapshot {
  if (util2 !== undefined) {
    if (!isUtilizationLike(util1) || !isUtilizationLike(util2)) {
      throw nodeError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        'The "utilization1" and "utilization2" arguments must be eventLoopUtilization objects.',
      );
    }
    const idle = util1.idle - util2.idle;
    const active = util1.active - util2.active;
    const total = idle + active;
    return { idle, active, utilization: total <= 0 ? 0 : active / total };
  }
  const elapsed = Math.max(0, performance.now() - startMs);
  const current = { idle: 0, active: elapsed, utilization: elapsed > 0 ? 1 : 0 };
  if (util1 !== undefined) {
    if (!isUtilizationLike(util1)) {
      throw nodeError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        'The "utilization1" argument must be an eventLoopUtilization object.',
      );
    }
    const idle = current.idle - util1.idle;
    const active = current.active - util1.active;
    const total = idle + active;
    return { idle, active, utilization: total <= 0 ? 0 : active / total };
  }
  return current;
}

export function createWorkerThreads(
  defaults: () => { cwd: string; env: Record<string, unknown>; pid: number; execArgv: string[] },
  retain: () => void,
  release: () => void,
  output: (stream: 'stdout' | 'stderr', bytes: Uint8Array) => void,
  context?: { port: MessagePort; data: unknown; id: number },
) {
  ensureChannelPrototypes();
  const environmentData = new Map<unknown, unknown>();
  const parent = context ? createThreadPort(context.port, retain, release) : undefined;

  function setEnvironmentData(key: unknown, value?: unknown): void {
    if (value === undefined) {
      environmentData.delete(key);
    } else {
      environmentData.set(key, value);
    }
  }

  function getEnvironmentData(key: unknown): unknown {
    return environmentData.get(key);
  }

  async function postMessageToThread(
    threadId: unknown,
    _value: unknown,
    _transferList?: unknown,
    _timeout?: unknown,
  ): Promise<void> {
    if (typeof threadId !== 'number') {
      throw nodeError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        'The "threadId" argument must be of type number.',
      );
    }
    if (!Number.isInteger(threadId) || threadId < 0 || threadId > 0xffffffff) {
      throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "threadId" is out of range.');
    }
    throw nodeError(
      Error,
      'ERR_WORKER_MESSAGING_FAILED',
      'Cannot find the destination thread or listener',
    );
  }

  class GuestWorker extends EventEmitter {
    #threadId = -1;
    #stdout: Readable | null;
    #stderr: Readable | null;
    #settled = false;
    #holding = false;
    #startedAt = performance.now();
    #performance: {
      eventLoopUtilization: (u1?: unknown, u2?: unknown) => UtilizationSnapshot;
    };
    #messaging: ReturnType<typeof createThreadPort>;
    #terminate: () => Promise<number | undefined>;

    constructor(filename: unknown, options: unknown = {}) {
      super();
      if (typeof filename !== 'string' || !filename || !record(options))
        throw fault('EINVAL', 'Invalid Worker arguments');
      if (
        Object.keys(options).some(
          (key) => !['workerData', 'stdout', 'stderr', 'env', 'execArgv'].includes(key),
        )
      )
        throw fault('ENOSYS', 'Unsupported Worker option');
      if (
        (options.stdout !== undefined && typeof options.stdout !== 'boolean') ||
        (options.stderr !== undefined && typeof options.stderr !== 'boolean')
      )
        throw fault('EINVAL', 'Invalid Worker stdio options');
      const inherited = defaults();
      const execArgv = parseExecArgv(
        options.execArgv === undefined ? inherited.execArgv : options.execArgv,
      ).argv;
      const suppliedEnv = options.env;
      if (suppliedEnv === SHARE_ENV)
        throw fault('ENOSYS', 'SHARE_ENV is not supported across browser Workers');
      if (suppliedEnv !== undefined && !record(suppliedEnv))
        throw fault('EINVAL', 'Worker env must be an object');
      const envEntries = Object.entries(suppliedEnv ?? inherited.env);
      if (suppliedEnv !== undefined && envEntries.some(([, value]) => typeof value !== 'string'))
        throw fault('ENOSYS', 'Worker env requires string values');
      // Copy before creating resources or returning to guest code. Explicit env
      // replaces inheritance; neither the parent nor options object is shared.
      const env = Object.fromEntries(
        envEntries
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      );
      // Snapshot and validate synchronously, before requesting any host resources.
      const data = snapshotThreadValue(options.workerData);
      threadValueSize(data);
      const control = new NativeMessageChannel();
      const messages = new NativeMessageChannel();
      this.#messaging = createThreadPort(messages.port1, retain, release, true);
      this.#messaging.api.on('message', (value) => this.emit('message', value));
      this.#stdout = options.stdout ? new Readable({ read() {} }) : null;
      this.#stderr = options.stderr ? new Readable({ read() {} }) : null;
      this.#performance = {
        eventLoopUtilization: (u1?: unknown, u2?: unknown) =>
          this.#settled
            ? { idle: 0, active: 0, utilization: 0 }
            : computeWorkerElu(this.#startedAt, u1, u2),
      };
      let resolveExit: (code: number) => void = () => {};
      const exit = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      this.#terminate = () => {
        if (this.#settled) return Promise.resolve(undefined);
        control.port1.postMessage({ type: 'kill', version: VERSION });
        return exit;
      };
      let size = 0;
      this.#holding = true;
      retain();
      const finish = (code: number, error?: Error) => {
        if (this.#settled) return;
        this.#settled = true;
        control.port1.close();
        this.#messaging.stop();
        this.#threadId = -1;
        this.#stdout?.push(null);
        this.#stderr?.push(null);
        try {
          if (error) this.emit('error', error);
          this.emit('exit', code);
        } finally {
          resolveExit(code);
          if (this.#holding) {
            this.#holding = false;
            release();
          }
        }
      };
      // Startup has no deadline, as in Node. The host answers every start request
      // with 'spawned' or 'error' (its only wait, the kernel attach request, has its
      // own bound), and the thread's exit or failure arrives on this channel.
      // Worker events run in the context that constructed the Worker.
      control.port1.onmessage = captured((event: MessageEvent<unknown>) => {
        const message = event.data;
        if (this.#settled || !record(message) || message.version !== VERSION) return;
        if (message.type === 'spawned' && typeof message.pid === 'number') {
          this.#threadId = message.pid;
        } else if (message.type === 'thread-online') {
          this.emit('online');
        } else if (message.type === 'thread-error' && typeof message.message === 'string') {
          const error = new Error(message.message);
          if (typeof message.name === 'string') error.name = message.name;
          this.emit('error', error);
        } else if (
          message.type === 'output' &&
          (message.stream === 'stdout' || message.stream === 'stderr') &&
          message.bytes instanceof Uint8Array
        ) {
          // Only bytes retained in a Readable count; unpiped output continues to the
          // parent's own stream, whose destination owns its bounds.
          const pipe = message.stream === 'stdout' ? this.#stdout : this.#stderr;
          if (!pipe) output(message.stream, message.bytes);
          else {
            size += message.bytes.byteLength;
            if (size > runtimePolicyLimits().child.outputBytes) {
              control.port1.postMessage({ type: 'kill', version: VERSION });
              finish(1, fault('E2BIG', 'Thread output exceeds limit'));
            } else pipe.push(Buffer.from(message.bytes));
          }
        } else if (message.type === 'exit' && typeof message.code === 'number')
          finish(message.code);
        else if (message.type === 'error' && typeof message.message === 'string')
          finish(
            1,
            fault(typeof message.code === 'string' ? message.code : 'EIO', message.message),
          );
      });
      try {
        self.postMessage(
          {
            type: 'spawn-child',
            version: VERSION,
            command: 'node',
            args: [filename],
            execArgv,
            options: { cwd: inherited.cwd, env },
            stdinPipe: false,
            stdinInherit: false,
            port: control.port2,
            thread: { port: messages.port2, data, processId: inherited.pid },
          },
          [control.port2, messages.port2],
        );
      } catch (error) {
        messages.port2.close();
        control.port2.close();
        finish(1, error instanceof Error ? error : fault('EIO', String(error)));
      }
    }

    get threadId(): number {
      return this.#threadId;
    }

    get stdin(): null {
      return null;
    }

    get stdout(): Readable | null {
      return this.#stdout;
    }

    get stderr(): Readable | null {
      return this.#stderr;
    }

    get resourceLimits(): Record<string, number> {
      return this.#settled ? {} : { ...DEFAULT_WORKER_RESOURCE_LIMITS };
    }

    get performance(): {
      eventLoopUtilization: (u1?: unknown, u2?: unknown) => UtilizationSnapshot;
    } {
      return this.#performance;
    }

    ref(): this {
      if (!this.#settled && !this.#holding) {
        this.#holding = true;
        retain();
      }
      return this;
    }

    unref(): this {
      if (!this.#settled && this.#holding) {
        this.#holding = false;
        release();
      }
      return this;
    }

    terminate() {
      return this.#terminate();
    }

    postMessage(value: unknown, transfer?: unknown) {
      this.#messaging.api.postMessage(value, transfer);
    }

    async [Symbol.asyncDispose](): Promise<void> {
      await this.terminate();
    }
  }

  return {
    module: {
      isInternalThread: false,
      isMainThread: !context,
      MessagePort: globalThis.MessagePort,
      MessageChannel: class {
        constructor() {
          throw fault('ENOSYS', 'Guest thread channels are not implemented');
        }
      },
      BroadcastChannel: globalThis.BroadcastChannel,
      markAsUncloneable,
      markAsUntransferable,
      isMarkedAsUntransferable,
      moveMessagePortToContext,
      receiveMessageOnPort,
      resourceLimits: context ? { ...DEFAULT_WORKER_RESOURCE_LIMITS } : {},
      postMessageToThread,
      threadId: context?.id ?? 0,
      SHARE_ENV,
      Worker: GuestWorker,
      parentPort: parent?.api ?? null,
      workerData: context ? context.data : null,
      setEnvironmentData,
      getEnvironmentData,
    },
    ready() {
      parent?.ready();
    },
  };
}
