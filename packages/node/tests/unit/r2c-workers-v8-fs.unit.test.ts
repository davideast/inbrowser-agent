import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import * as hostV8 from 'node:v8';
import { describe, expect, it } from 'vitest';
import { createFsBuiltins } from '../../src/builtins/fs';
import { createPerfHooksBuiltin } from '../../src/builtins/perf-hooks';
import { createV8Builtin } from '../../src/builtins/v8';
import { createWorkerThreadsBuiltin } from '../../src/builtins/worker-threads';
import { createFs } from '../../src/fs';
import { type Syscalls, VERSION } from '../../src/protocol';
import { snapshotThreadValue } from '../../src/thread-clone';
import { record } from '../../src/value-guards';

describe('Lane R2c: Workers, V8, PerfHooks & FS', () => {
  describe('Slice 1: node:v8 Serializer, Deserializer, DefaultSerializer, DefaultDeserializer, serialize & deserialize', () => {
    const v8 = createV8Builtin({
      advisoryHeapLimit: 64 * 1024 * 1024,
      callTimeoutMs: 1000,
      samplePageHeap: () => ({ total: 8 * 1024 * 1024, used: 4 * 1024 * 1024 }),
    }) as Record<string, unknown>;

    it('exposes Serializer, Deserializer, DefaultSerializer, DefaultDeserializer, serialize, and deserialize with Node v22.18.0 prototype inheritance', () => {
      const Serializer = v8.Serializer as { new (): Record<string, unknown>; prototype: object };
      const Deserializer = v8.Deserializer as {
        new (buf: Uint8Array): Record<string, unknown>;
        prototype: object;
      };
      const DefaultSerializer = v8.DefaultSerializer as {
        new (): Record<string, unknown>;
        prototype: object;
      };
      const DefaultDeserializer = v8.DefaultDeserializer as {
        new (buf: Uint8Array): Record<string, unknown>;
        prototype: object;
      };

      expect(typeof Serializer).toBe('function');
      expect(typeof Deserializer).toBe('function');
      expect(typeof DefaultSerializer).toBe('function');
      expect(typeof DefaultDeserializer).toBe('function');
      expect(typeof v8.serialize).toBe('function');
      expect(typeof v8.deserialize).toBe('function');

      expect(Object.getPrototypeOf(DefaultSerializer.prototype)).toBe(Serializer.prototype);
      expect(Object.getPrototypeOf(DefaultSerializer)).toBe(Serializer);
      expect(Object.getPrototypeOf(DefaultDeserializer.prototype)).toBe(Deserializer.prototype);
      expect(Object.getPrototypeOf(DefaultDeserializer)).toBe(Deserializer);
    });

    it('encodes exact V8 wire v15 framing and low-level Serializer/Deserializer primitives', () => {
      const Serializer = v8.Serializer as { new (): Record<string, (...a: unknown[]) => unknown> };
      const Deserializer = v8.Deserializer as {
        new (input: Uint8Array): Record<string, (...a: unknown[]) => unknown>;
      };

      const ser = new Serializer();
      ser.writeHeader();
      ser.writeUint32(300);
      ser.writeUint64(0x12, 0x34567890);
      ser.writeDouble(2.5);
      ser.writeRawBytes(Buffer.from([0xaa, 0xbb]));
      const buf = ser.releaseBuffer() as Buffer;
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.toString('hex')).toBe('ff0fac0290f1d9a2a3020000000000000440aabb');

      const des = new Deserializer(buf);
      expect(des.readHeader()).toBe(true);
      expect(des.getWireFormatVersion()).toBe(15);
      expect(des.readUint32()).toBe(300);
      expect(des.readUint64()).toEqual([0x12, 0x34567890]);
      expect(des.readDouble()).toBe(2.5);
      const raw = des.readRawBytes(2) as Buffer;
      expect(Buffer.isBuffer(raw)).toBe(true);
      expect(raw.toString('hex')).toBe('aabb');
    });

    it('roundtrips rich JS graphs bidirectionally with native node:v8', () => {
      const serialize = v8.serialize as (value: unknown) => Buffer;
      const deserialize = v8.deserialize as (buffer: Uint8Array) => unknown;

      const sharedBacking = new Uint8Array([7, 8, 9, 10]).buffer;
      const circular: Record<string, unknown> = { label: 'root' };
      circular.self = circular;

      const sparse = new Array<unknown>(4);
      sparse[1] = 'holey';
      const arrWithProps = Object.assign([10, 20], { extra: 'meta' });
      const typedErr = new TypeError('bad input', { cause: new RangeError('out of bounds') });
      typedErr.stack = 'TypeError: bad input\n    at frame:1:1';

      const payload = {
        primitives: [
          undefined,
          null,
          true,
          false,
          0,
          -0,
          1,
          -1,
          2147483647,
          -2147483648,
          2147483648,
          3.141592653589793,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
        ],
        bigints: [0n, 1n, -1n, 0x0102030405060708090a0b0c0d0e0f10n, -999999999999999999999999n],
        strings: ['', 'ascii', '\u00e9\u00ff', 'hello \u4e2d\u6587 \ud83d\ude80'],
        dateValid: new Date(1700000000000),
        dateInvalid: new Date(Number.NaN),
        regex: /pattern-[0-9]+/dgimsuy,
        boxed: [Object(true), Object(false), Object(42), Object('boxed'), Object(9n)],
        ab: new Uint8Array([1, 2, 3]).buffer,
        u8Sub: new Uint8Array([99, 10, 20, 88]).subarray(1, 3),
        i16: new Int16Array([-1, 258]),
        f64: new Float64Array([1.5, -2.25]),
        bi64: new BigInt64Array([-5n, 9n]),
        buf: Buffer.from([4, 5, 6]),
        dv: new DataView(sharedBacking, 1, 2),
        map: new Map<unknown, unknown>([
          ['k', 1],
          [{ nestedKey: true }, 'objKeyVal'],
        ]),
        set: new Set<unknown>(['alpha', 42]),
        nullProto: Object.assign(Object.create(null), { bare: 7 }),
        sparse,
        arrWithProps,
        err: typedErr,
        circular,
      };

      const runtimeBytes = serialize(payload);
      // Native node:v8 must decode bytes produced by our runtime!
      const decodedByHost = hostV8.deserialize(runtimeBytes) as Record<string, unknown>;
      expect(decodedByHost.strings).toEqual(payload.strings);
      expect(decodedByHost.bigints).toEqual(payload.bigints);
      expect(Object.is((decodedByHost.primitives as unknown[])[5], -0)).toBe(true);
      expect(Number.isNaN((decodedByHost.primitives as unknown[])[12])).toBe(true);
      expect((decodedByHost.dateValid as Date).getTime()).toBe(1700000000000);
      expect(Number.isNaN((decodedByHost.dateInvalid as Date).getTime())).toBe(true);
      expect((decodedByHost.regex as RegExp).source).toBe('pattern-[0-9]+');
      expect((decodedByHost.regex as RegExp).flags).toBe('dgimsuy');
      expect(Buffer.isBuffer(decodedByHost.buf)).toBe(true);
      expect(Array.from(decodedByHost.buf as Uint8Array)).toEqual([4, 5, 6]);
      expect(Array.from(decodedByHost.u8Sub as Uint8Array)).toEqual([10, 20]);
      expect(Array.from(decodedByHost.i16 as Int16Array)).toEqual([-1, 258]);
      expect((decodedByHost.dv as DataView).getUint8(0)).toBe(8);
      expect(Object.getPrototypeOf(decodedByHost.nullProto)).toBe(Object.prototype);
      expect((decodedByHost.nullProto as { bare: number }).bare).toBe(7);
      expect(1 in (decodedByHost.sparse as unknown[])).toBe(true);
      expect(0 in (decodedByHost.sparse as unknown[])).toBe(false);
      expect((decodedByHost.arrWithProps as unknown as { extra: string }).extra).toBe('meta');
      expect(decodedByHost.err).toBeInstanceOf(TypeError);
      expect(((decodedByHost.err as Error).cause as Error).message).toBe('out of bounds');
      expect((decodedByHost.circular as { self: unknown }).self).toBe(decodedByHost.circular);

      // Our runtime must decode bytes produced by native node:v8!
      const hostBytes = hostV8.serialize(payload);
      const decodedByRuntime = deserialize(hostBytes) as Record<string, unknown>;
      expect(decodedByRuntime.strings).toEqual(payload.strings);
      expect(decodedByRuntime.bigints).toEqual(payload.bigints);
      expect(Object.is((decodedByRuntime.primitives as unknown[])[5], -0)).toBe(true);
      expect(Buffer.isBuffer(decodedByRuntime.buf)).toBe(true);
      expect(Array.from(decodedByRuntime.buf as Uint8Array)).toEqual([4, 5, 6]);
      expect(Array.from(decodedByRuntime.bi64 as BigInt64Array)).toEqual([-5n, 9n]);
      expect(Object.getPrototypeOf(decodedByRuntime.nullProto)).toBe(Object.prototype);
      expect((decodedByRuntime.nullProto as { bare: number }).bare).toBe(7);
      expect(0 in (decodedByRuntime.sparse as unknown[])).toBe(false);
      expect((decodedByRuntime.sparse as unknown[])[1]).toBe('holey');
      expect((decodedByRuntime.arrWithProps as unknown as { extra: string }).extra).toBe('meta');
      expect(decodedByRuntime.err).toBeInstanceOf(TypeError);
      expect(((decodedByRuntime.err as Error).cause as Error).message).toBe('out of bounds');
      expect((decodedByRuntime.circular as { self: unknown }).self).toBe(decodedByRuntime.circular);
      expect((decodedByRuntime.boxed as unknown[])[0]).toBeInstanceOf(Boolean);
      expect((decodedByRuntime.boxed as unknown[])[2]).toBeInstanceOf(Number);
      expect(Number((decodedByRuntime.boxed as unknown[])[2])).toBe(42);
    });

    it('supports bare Serializer V8 ArrayBufferView sharing, transferArrayBuffer, and custom host/SAB hooks', () => {
      const Serializer = v8.Serializer as { new (): Record<string, (...a: unknown[]) => unknown> };
      const Deserializer = v8.Deserializer as {
        new (input: Uint8Array): Record<string, (...a: unknown[]) => unknown>;
      };

      // Bare Serializer shares underlying ArrayBuffer between two subviews
      const backing = new Uint8Array([7, 8, 9]).buffer;
      const bare = new Serializer();
      bare.writeHeader();
      bare.writeValue([new Uint8Array(backing, 0, 2), new Uint8Array(backing, 1, 2)]);
      const bareBuf = bare.releaseBuffer() as Buffer;
      expect(bareBuf.toString('hex')).toBe('ff0f4102420307080956420002005e015642010200240002');
      const bareDes = new Deserializer(bareBuf);
      bareDes.readHeader();
      const [v1, v2] = bareDes.readValue() as [Uint8Array, Uint8Array];
      expect(v1.buffer).toBe(v2.buffer);
      expect(Array.from(v1)).toEqual([7, 8]);
      expect(Array.from(v2)).toEqual([8, 9]);

      // transferArrayBuffer
      const xferSer = new Serializer();
      const srcAb = new Uint8Array([1, 2]).buffer;
      xferSer.transferArrayBuffer(0, srcAb);
      xferSer.writeHeader();
      xferSer.writeValue(new Uint8Array(srcAb));
      const xferBuf = xferSer.releaseBuffer() as Buffer;
      expect(xferBuf.toString('hex')).toBe('ff0f74005642000200');

      const xferDes = new Deserializer(xferBuf);
      const dstAb = new Uint8Array([44, 55]).buffer;
      xferDes.transferArrayBuffer(0, dstAb);
      xferDes.readHeader();
      const transferredView = xferDes.readValue() as Uint8Array;
      expect(transferredView.buffer).toBe(dstAb);
      expect(Array.from(transferredView)).toEqual([44, 55]);
    });
  });

  describe('Slice 2: node:worker_threads APIs, prototype getters, port utilities & Worker lifecycle', () => {
    function makeThreads(isChild = false) {
      let retained = 0;
      const channel = new globalThis.MessageChannel();
      const built = createWorkerThreadsBuiltin({
        defaults: () => ({ cwd: '/app', env: { PATH: '/bin' }, pid: 100, execArgv: [] }),
        retain: () => {
          retained++;
        },
        release: () => {
          retained--;
        },
        output: () => {},
        context: isChild ? { port: channel.port2, data: { init: true }, id: 7 } : undefined,
      });
      return {
        wt: built.module as Record<string, unknown>,
        ready: built.ready,
        channel,
        getRetained: () => retained,
      };
    }

    it('exposes SHARE_ENV, isInternalThread, resourceLimits, BroadcastChannel, MessagePort, and keeps MessageChannel ENOSYS', () => {
      const main = makeThreads(false);
      const child = makeThreads(true);
      try {
        expect(main.wt.SHARE_ENV).toBe(Symbol.for('nodejs.worker_threads.SHARE_ENV'));
        expect(main.wt.isInternalThread).toBe(false);
        expect(main.wt.resourceLimits).toEqual({});
        expect(child.wt.isInternalThread).toBe(false);
        expect(child.wt.resourceLimits).toMatchObject({
          maxYoungGenerationSizeMb: expect.any(Number),
          maxOldGenerationSizeMb: expect.any(Number),
          codeRangeSizeMb: expect.any(Number),
          stackSizeMb: expect.any(Number),
        });

        expect(main.wt.MessagePort).toBe(globalThis.MessagePort);
        expect(main.wt.BroadcastChannel).toBe(globalThis.BroadcastChannel);
        expect(typeof Reflect.get(globalThis.MessagePort.prototype, 'ref')).toBe('function');
        expect(typeof Reflect.get(globalThis.MessagePort.prototype, 'unref')).toBe('function');
        expect(typeof Reflect.get(globalThis.MessagePort.prototype, 'hasRef')).toBe('function');
        expect(typeof Reflect.get(globalThis.BroadcastChannel.prototype, 'ref')).toBe('function');
        expect(typeof Reflect.get(globalThis.BroadcastChannel.prototype, 'unref')).toBe('function');

        const BcCtor = main.wt.BroadcastChannel as {
          new (
            name: string,
          ): BroadcastChannel & {
            ref(): BroadcastChannel;
            unref(): BroadcastChannel;
          };
        };
        const bc = new BcCtor('r2c-unit-bc');
        expect(bc.unref()).toBe(bc);
        expect(bc.ref()).toBe(bc);
        bc.close();

        const ThreadMC = main.wt.MessageChannel as { new (): unknown };
        expect(() => new ThreadMC()).toThrow(/ENOSYS|not implemented/);
      } finally {
        main.channel.port1.close();
        main.channel.port2.close();
        child.channel.port1.close();
        child.channel.port2.close();
      }
    });

    it('supports getEnvironmentData/setEnvironmentData, markAsUntransferable, and markAsUncloneable', () => {
      const { wt, channel } = makeThreads(false);
      try {
        const setEnv = wt.setEnvironmentData as (k: unknown, v: unknown) => void;
        const getEnv = wt.getEnvironmentData as (k: unknown) => unknown;
        setEnv('cfg', { retries: 3 });
        expect(getEnv('cfg')).toEqual({ retries: 3 });
        setEnv('cfg', undefined);
        expect(getEnv('cfg')).toBeUndefined();

        const markUntransferable = wt.markAsUntransferable as (o: unknown) => void;
        const isUntransferable = wt.isMarkedAsUntransferable as (o: unknown) => boolean;
        const markUncloneable = wt.markAsUncloneable as (o: unknown) => void;

        const ab = new ArrayBuffer(4);
        expect(isUntransferable(ab)).toBe(false);
        expect(isUntransferable(null)).toBe(false);
        markUntransferable(ab);
        expect(isUntransferable(ab)).toBe(true);

        const secret = { token: 'abc' };
        markUncloneable(secret);
        expect(() => snapshotThreadValue({ secret })).toThrow();
      } finally {
        channel.port1.close();
        channel.port2.close();
      }
    });

    it('supports receiveMessageOnPort on MessagePort & parentPort, moveMessagePortToContext, and postMessageToThread', async () => {
      const child = makeThreads(true);
      const mc = new globalThis.MessageChannel();
      try {
        const receiveMessageOnPort = child.wt.receiveMessageOnPort as (
          port: unknown,
        ) => { message: unknown } | undefined;
        const moveMessagePortToContext = child.wt.moveMessagePortToContext as (
          port: unknown,
          ctx: unknown,
        ) => unknown;
        const postMessageToThread = child.wt.postMessageToThread as (
          threadId: unknown,
          value: unknown,
        ) => Promise<void>;

        expect(() => receiveMessageOnPort({})).toThrow(TypeError);
        expect(receiveMessageOnPort(mc.port2)).toBeUndefined();
        mc.port1.postMessage({ seq: 1 });
        mc.port1.postMessage({ seq: 2 });
        expect(receiveMessageOnPort(mc.port2)).toEqual({ message: { seq: 1 } });
        expect(receiveMessageOnPort(mc.port2)).toEqual({ message: { seq: 2 } });
        expect(receiveMessageOnPort(mc.port2)).toBeUndefined();

        // Also drains ThreadPort (parentPort) when a message is queued before listener attachment
        child.channel.port1.postMessage({
          version: VERSION,
          type: 'message',
          id: 1,
          value: { fromParent: 99 },
        });
        await new Promise((r) => setTimeout(r, 15));
        expect(receiveMessageOnPort(child.wt.parentPort)).toEqual({
          message: { fromParent: 99 },
        });
        expect(receiveMessageOnPort(child.wt.parentPort)).toBeUndefined();

        expect(() => moveMessagePortToContext({}, {})).toThrow(TypeError);
        expect(() => moveMessagePortToContext(mc.port1, null)).toThrow(TypeError);
        expect(moveMessagePortToContext(mc.port1, {})).toBe(mc.port1);

        await expect(postMessageToThread('bad', {})).rejects.toMatchObject({
          code: 'ERR_INVALID_ARG_TYPE',
        });
        await expect(postMessageToThread(9999, { ping: true })).rejects.toMatchObject({
          code: 'ERR_WORKER_MESSAGING_FAILED',
        });
      } finally {
        mc.port1.close();
        mc.port2.close();
        child.channel.port1.close();
        child.channel.port2.close();
      }
    });

    it('defines threadId, stdin, stdout, stderr, resourceLimits, performance as Worker.prototype getters plus ref/unref/[Symbol.asyncDispose]', async () => {
      const { wt, channel, getRetained } = makeThreads(false);
      const WorkerCtor = wt.Worker as {
        new (
          filename: string,
          options?: Record<string, unknown>,
        ): Record<string, unknown> & {
          ref(): unknown;
          unref(): unknown;
          terminate(): Promise<number | undefined>;
          [Symbol.asyncDispose](): Promise<void>;
        };
        prototype: object;
      };

      for (const prop of [
        'threadId',
        'stdin',
        'stdout',
        'stderr',
        'resourceLimits',
        'performance',
      ]) {
        const desc = Object.getOwnPropertyDescriptor(WorkerCtor.prototype, prop);
        expect(desc?.get, `Worker.prototype.${prop} should be a getter`).toBeTypeOf('function');
      }
      expect(typeof Reflect.get(WorkerCtor.prototype, 'ref', WorkerCtor.prototype)).toBe(
        'function',
      );
      expect(typeof Reflect.get(WorkerCtor.prototype, 'unref', WorkerCtor.prototype)).toBe(
        'function',
      );
      expect(
        typeof Reflect.get(WorkerCtor.prototype, Symbol.asyncDispose, WorkerCtor.prototype),
      ).toBe('function');

      // Intercept self.postMessage in Node unit test realm to simulate host spawn & exit
      const prevSelf = Reflect.get(globalThis, 'self');
      let spawnedControlPort: MessagePort | undefined;
      Object.defineProperty(globalThis, 'self', {
        configurable: true,
        writable: true,
        value: {
          postMessage(msg: Record<string, unknown>, transfer?: Transferable[]) {
            spawnedControlPort = msg.port as MessagePort;
            spawnedControlPort.onmessage = (ev: MessageEvent<Record<string, unknown>>) => {
              if (ev.data?.type === 'kill') {
                spawnedControlPort?.postMessage({ type: 'exit', version: VERSION, code: 0 });
                spawnedControlPort?.close();
              }
            };
            spawnedControlPort.postMessage({ type: 'spawned', version: VERSION, pid: 42 });
            // Close thread port2 so it doesn't dangle in test
            if (Array.isArray(transfer) && transfer[1] instanceof MessagePort) {
              transfer[1].close();
            }
          },
        },
      });

      try {
        const w = new WorkerCtor('./worker.cjs', { stdout: true });
        expect(getRetained()).toBe(1);
        expect(w.stdin).toBeNull();
        expect(w.stdout).not.toBeNull();
        expect(w.stderr).toBeNull();
        expect(
          typeof (w.performance as { eventLoopUtilization: unknown }).eventLoopUtilization,
        ).toBe('function');

        expect(w.unref()).toBe(w);
        expect(getRetained()).toBe(0);
        expect(w.ref()).toBe(w);
        expect(getRetained()).toBe(1);

        await w[Symbol.asyncDispose]();
        expect(getRetained()).toBe(0);
        expect(w.threadId).toBe(-1);
        expect(w.resourceLimits).toEqual({});
      } finally {
        if (prevSelf === undefined) Reflect.deleteProperty(globalThis, 'self');
        else
          Object.defineProperty(globalThis, 'self', {
            configurable: true,
            writable: true,
            value: prevSelf,
          });
        spawnedControlPort?.close();
        channel.port1.close();
        channel.port2.close();
      }
    });
  });

  describe('Slice 3: node:perf_hooks monitorEventLoopDelay, eventLoopUtilization, nodeTiming & PerformanceResourceTiming', () => {
    function makePerfHooks() {
      let fakeHrNs = 1_000_000_000n;
      return createPerfHooksBuiltin({
        setImmediate: (cb) => setImmediate(cb),
        hrtimeNs: () => {
          fakeHrNs += 12_000_000n;
          return fakeHrNs;
        },
        setInterval: (fn, delay) => setInterval(fn, Number(delay)),
        clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
      }) as Record<string, unknown>;
    }

    it('implements monitorEventLoopDelay with IntervalHistogram lifecycle and validation', async () => {
      const ph = makePerfHooks();
      const monitorEventLoopDelay = ph.monitorEventLoopDelay as (opts?: unknown) => Record<
        string,
        unknown
      > & {
        enable(): boolean;
        disable(): boolean;
        reset(): void;
        count: number;
        min: number;
        max: number;
        mean: number;
        percentile(p: number): number;
      };

      expect(typeof monitorEventLoopDelay).toBe('function');
      expect(() => monitorEventLoopDelay('bad')).toThrow(TypeError);
      expect(() => monitorEventLoopDelay({ resolution: 0 })).toThrow(RangeError);

      const eld = monitorEventLoopDelay({ resolution: 5 });
      expect(eld.count).toBe(0);
      expect(eld.enable()).toBe(true);
      expect(eld.enable()).toBe(false);
      await new Promise((r) => setTimeout(r, 20));
      expect(eld.disable()).toBe(true);
      expect(eld.disable()).toBe(false);
      expect(eld.count).toBeGreaterThanOrEqual(1);
      expect(eld.min).toBeGreaterThanOrEqual(5_000_000);
      expect(eld.percentile(50)).toBeGreaterThanOrEqual(5_000_000);
      eld.reset();
      expect(eld.count).toBe(0);
    });

    it('implements performance.eventLoopUtilization (0/1/2-arg) and performance.nodeTiming on browser-like Performance.prototype', () => {
      const perfProto = Object.getPrototypeOf(globalThis.performance) as object;
      const savedElu = Object.getOwnPropertyDescriptor(perfProto, 'eventLoopUtilization');
      const savedNt = Object.getOwnPropertyDescriptor(perfProto, 'nodeTiming');
      Reflect.deleteProperty(perfProto, 'eventLoopUtilization');
      Reflect.deleteProperty(perfProto, 'nodeTiming');
      try {
        const ph = makePerfHooks();
        const perf = ph.performance as Performance & {
          eventLoopUtilization(
            u1?: { idle: number; active: number; utilization?: number },
            u2?: { idle: number; active: number; utilization?: number },
          ): { idle: number; active: number; utilization: number };
          nodeTiming: PerformanceEntry & {
            nodeStart: number;
            v8Start: number;
            bootstrapComplete: number;
            environment: number;
            loopStart: number;
            loopExit: number;
            idleTime: number;
            uvMetricsInfo: { loopCount: number; events: number; eventsWaiting: number };
            toJSON(): Record<string, unknown>;
          };
        };

        const u0 = perf.eventLoopUtilization();
        expect(typeof u0.idle).toBe('number');
        expect(typeof u0.active).toBe('number');
        expect(u0.utilization).toBeGreaterThanOrEqual(0);
        expect(u0.utilization).toBeLessThanOrEqual(1);

        const u1 = perf.eventLoopUtilization(u0);
        expect(u1.idle).toBeGreaterThanOrEqual(0);
        expect(u1.active).toBeGreaterThanOrEqual(0);

        const u2 = perf.eventLoopUtilization({ idle: 100, active: 300 }, { idle: 50, active: 100 });
        expect(u2).toEqual({ idle: 50, active: 200, utilization: 0.8 });

        const nt = perf.nodeTiming;
        expect(nt).toBeInstanceOf(globalThis.PerformanceEntry);
        expect(nt.name).toBe('node');
        expect(nt.entryType).toBe('node');
        expect(nt.startTime).toBe(0);
        expect(nt.duration).toBeGreaterThanOrEqual(0);
        expect(nt.loopExit).toBe(-1);
        expect(nt.uvMetricsInfo).toEqual({
          loopCount: expect.any(Number),
          events: expect.any(Number),
          eventsWaiting: expect.any(Number),
        });
        expect(nt.toJSON()).toMatchObject({
          name: 'node',
          entryType: 'node',
          startTime: 0,
          loopExit: -1,
        });

        const fakeProcess = new EventEmitter();
        let loopExitedAt = -1;
        const phWithLoopExit = createPerfHooksBuiltin({
          setImmediate: (cb) => setImmediate(cb),
          hrtimeNs: () => 2_000_000_000n,
          process: fakeProcess,
          getLoopExit: () => loopExitedAt,
        });
        expect(fakeProcess.listenerCount('exit')).toBe(0);
        const nt2 = Reflect.get(phWithLoopExit.performance, 'nodeTiming');
        expect(record(nt2)).toBe(true);
        if (record(nt2)) {
          expect(nt2.loopExit).toBe(-1);
          loopExitedAt = 42.5;
          expect(nt2.loopExit).toBe(42.5);
        }
      } finally {
        if (savedElu) Object.defineProperty(perfProto, 'eventLoopUtilization', savedElu);
        if (savedNt) Object.defineProperty(perfProto, 'nodeTiming', savedNt);
      }
    });

    it('exports PerformanceResourceTiming and performance.markResourceTiming without altering PerformanceObserver.supportedEntryTypes', () => {
      const perfProto = Object.getPrototypeOf(globalThis.performance) as object;
      const savedMrt = Object.getOwnPropertyDescriptor(perfProto, 'markResourceTiming');
      Reflect.deleteProperty(perfProto, 'markResourceTiming');
      try {
        const ph = makePerfHooks();
        expect(ph.PerformanceResourceTiming).toBe(globalThis.PerformanceResourceTiming);
        const perf = ph.performance as Performance & {
          markResourceTiming: (...args: unknown[]) => PerformanceResourceTiming;
        };
        expect(typeof perf.markResourceTiming).toBe('function');

        const rt = perf.markResourceTiming(
          {
            startTime: 10,
            redirectStartTime: 0,
            redirectEndTime: 0,
            postRedirectStartTime: 10,
            finalServiceWorkerStartTime: 0,
            finalNetworkRequestStartTime: 12,
            finalNetworkResponseStartTime: 18,
            endTime: 25,
            encodedBodySize: 64,
            decodedBodySize: 128,
            finalConnectionTimingInfo: null,
          },
          'https://items.example/1',
          'fetch',
          globalThis,
          '',
          { encodedSize: 64, decodedSize: 128 },
          200,
          '',
        );
        expect(rt).toBeInstanceOf(globalThis.PerformanceResourceTiming);
        expect(rt.name).toBe('https://items.example/1');
        expect(rt.entryType).toBe('resource');
        expect(rt.startTime).toBe(10);
        expect(rt.duration).toBe(15);
        expect(rt.responseEnd).toBe(25);
        expect(rt.encodedBodySize).toBe(64);
        expect(rt.decodedBodySize).toBe(128);

        const Obs = ph.PerformanceObserver as { supportedEntryTypes: readonly string[] };
        expect(Obs.supportedEntryTypes).toEqual(['function', 'mark', 'measure']);
      } finally {
        if (savedMrt) Object.defineProperty(perfProto, 'markResourceTiming', savedMrt);
      }
    });
  });

  describe('Slice 4: node:fs & node:fs/promises prototypes, descriptors, constants, fchmod, watchFile & promises.watch', () => {
    function makeMockFsHarness() {
      const files = new Map<string, { mode: number; content: Uint8Array; mtimeMs: number }>([
        ['/work', { mode: 0o040755, content: new Uint8Array(0), mtimeMs: 1700000000000 }],
        [
          '/work/item.txt',
          { mode: 0o100644, content: Buffer.from('hello'), mtimeMs: 1700000001000 },
        ],
      ]);
      const fds = new Map<number, string>();
      let nextFd = 10;
      let retained = 0;
      const watchChannel = new globalThis.MessageChannel();
      let lastWatchId = 0;

      const makeRawStat = (entry: { mode: number; content: Uint8Array; mtimeMs: number }) => ({
        dev: 1,
        ino: 2,
        mode: entry.mode,
        nlink: 1,
        uid: 1000,
        gid: 1000,
        rdev: 0,
        size: entry.content.byteLength,
        blksize: 4096,
        blocks: 1,
        atimeMs: entry.mtimeMs,
        mtimeMs: entry.mtimeMs,
        ctimeMs: entry.mtimeMs,
        birthtimeMs: entry.mtimeMs,
        atime: new Date(entry.mtimeMs),
        mtime: new Date(entry.mtimeMs),
        ctime: new Date(entry.mtimeMs),
        birthtime: new Date(entry.mtimeMs),
      });

      const sys: Syscalls = {
        call(name: string, args: unknown[]) {
          switch (name) {
            case 'fs.constants':
              return { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_RDWR: 2 };
            case 'fs.statSync':
            case 'fs.lstatSync': {
              const p = String(args[0]);
              const e = files.get(p);
              if (!e) {
                const opts = args[1] as { throwIfNoEntry?: boolean } | undefined;
                if (opts?.throwIfNoEntry === false) return undefined;
                throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
              }
              return makeRawStat(e);
            }
            case 'fs.fstatSync': {
              const p = fds.get(Number(args[0]));
              const e = p ? files.get(p) : undefined;
              if (!e) throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
              return makeRawStat(e);
            }
            case 'fs.openSync': {
              const p = String(args[0]);
              if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
              const fd = nextFd++;
              fds.set(fd, p);
              return fd;
            }
            case 'fs.closeSync': {
              const fd = Number(args[0]);
              if (!fds.delete(fd)) throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
              return undefined;
            }
            case 'fs.chmodSync': {
              const p = String(args[0]);
              const mode = Number(args[1]);
              const e = files.get(p);
              if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
              e.mode = (e.mode & 0o170000) | (mode & 0o7777);
              return undefined;
            }
            case 'fs.readdirSync': {
              const p = String(args[0]);
              const opts = args[1] as { withFileTypes?: boolean } | undefined;
              const out: Array<string | { name: string; mode: number }> = [];
              for (const [k, v] of files.entries()) {
                if (k !== p && k.startsWith(p + '/')) {
                  const base = k.slice(p.length + 1);
                  if (!base.includes('/')) {
                    out.push(opts?.withFileTypes ? { name: base, mode: v.mode } : base);
                  }
                }
              }
              return out;
            }
            case 'fs.realpathSync': {
              const p = String(args[0]);
              if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
              return p;
            }
            case 'fs.rmdirSync': {
              const p = String(args[0]);
              if (!files.delete(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
              return undefined;
            }
            case 'watch':
              lastWatchId = Number(args[0]);
              return undefined;
            case 'unwatch':
              return undefined;
            default:
              throw new Error(`Unhandled mock syscall: ${name}`);
          }
        },
      } as unknown as Syscalls;

      const rawFs = createFs(sys, () => '/work');
      const built = createFsBuiltins({
        fs: rawFs,
        sys,
        port: watchChannel.port2,
        cwd: () => '/work',
        retain: () => {
          retained++;
        },
        release: () => {
          retained--;
        },
        worked: () => {},
      });
      return {
        fs: built.fs as Record<string, unknown>,
        fsp: built['fs/promises'] as Record<string, unknown>,
        legacyConstants: built.constants,
        files,
        watchChannel,
        getLastWatchId: () => lastWatchId,
        getRetained: () => retained,
        close() {
          watchChannel.port1.close();
          watchChannel.port2.close();
        },
      };
    }

    it('exposes F_OK..X_OK, O_DSYNC, UV_FS_O_FILEMAP, accessor fs.promises, lchmod=undefined, and realpath.native', () => {
      const h = makeMockFsHarness();
      try {
        expect(h.fs.F_OK).toBe(0);
        expect(h.fs.R_OK).toBe(4);
        expect(h.fs.W_OK).toBe(2);
        expect(h.fs.X_OK).toBe(1);
        const constants = h.fs.constants as Record<string, number>;
        expect(constants.O_DSYNC).toBe(4096);
        expect(constants.UV_FS_O_FILEMAP).toBe(0);
        expect(h.legacyConstants.O_DSYNC).toBe(4096);
        expect(h.legacyConstants.UV_FS_O_FILEMAP).toBe(0);
        expect(h.legacyConstants.UV_DIRENT_FILE).toBe(constants.UV_DIRENT_FILE);
        expect(h.fs.constants).toBe(h.fsp.constants);

        const promisesDesc = Object.getOwnPropertyDescriptor(h.fs, 'promises');
        expect(typeof promisesDesc?.get).toBe('function');
        expect(h.fs.promises).toBe(h.fsp);

        expect('lchmod' in h.fs).toBe(true);
        expect(h.fs.lchmod).toBeUndefined();
        expect('lchmodSync' in h.fs).toBe(true);
        expect(h.fs.lchmodSync).toBeUndefined();

        const realpath = h.fs.realpath as ((
          p: string,
          cb: (err: unknown, resolved?: string) => void,
        ) => void) & {
          native: (p: string, cb: (err: unknown, resolved?: string) => void) => void;
        };
        expect(typeof realpath.native).toBe('function');
      } finally {
        h.close();
      }
    });

    it('defines Stats.prototype, Dirent.prototype, Dir[Symbol.asyncDispose], and ReadStream.prototype.pending + options.fs', async () => {
      const h = makeMockFsHarness();
      try {
        const Stats = h.fs.Stats as {
          new (...args: number[]): Record<string, unknown>;
          prototype: object;
        };
        const Dirent = h.fs.Dirent as {
          new (name: string, type: number, parentPath?: string): Record<string, unknown>;
          prototype: object;
        };
        expect(typeof Stats).toBe('function');
        expect(typeof Dirent).toBe('function');

        for (const m of [
          'isFile',
          'isDirectory',
          'isSymbolicLink',
          'isBlockDevice',
          'isCharacterDevice',
          'isFIFO',
          'isSocket',
        ]) {
          expect(typeof Reflect.get(Stats.prototype, m, Stats.prototype)).toBe('function');
          expect(typeof Reflect.get(Dirent.prototype, m, Dirent.prototype)).toBe('function');
        }
        for (const d of ['atime', 'mtime', 'ctime', 'birthtime']) {
          expect(Object.getOwnPropertyDescriptor(Stats.prototype, d)?.get).toBeTypeOf('function');
        }

        const st = (h.fs.statSync as (p: string) => Record<string, unknown>)('/work/item.txt');
        expect(st).toBeInstanceOf(Stats);
        expect(Object.prototype.hasOwnProperty.call(st, 'isFile')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(st, 'mtime')).toBe(false);
        expect((st.isFile as () => boolean)()).toBe(true);
        expect((st.isDirectory as () => boolean)()).toBe(false);
        expect(st.mtime).toBeInstanceOf(Date);

        const dirents = (
          h.fs.readdirSync as (p: string, o: object) => Array<Record<string, unknown>>
        )('/work', { withFileTypes: true });
        expect(dirents).toHaveLength(1);
        expect(dirents[0]).toBeInstanceOf(Dirent);
        expect(Object.prototype.hasOwnProperty.call(dirents[0], 'isFile')).toBe(false);
        expect((dirents[0]!.isFile as () => boolean)()).toBe(true);

        const dir = await (
          h.fsp.opendir as (p: string) => Promise<AsyncDisposable & { readSync(): unknown }>
        )('/work');
        await dir[Symbol.asyncDispose]();
        expect(() => dir.readSync()).toThrow(/ERR_DIR_CLOSED|closed/);

        const ReadStream = h.fs.ReadStream as {
          new (p: string, opts?: object): { bytesRead: number; path: unknown; pending: boolean };
          prototype: object;
        };
        expect(Object.getOwnPropertyDescriptor(ReadStream.prototype, 'pending')?.get).toBeTypeOf(
          'function',
        );
        const rs = new ReadStream('/x', { fs: { open() {}, read() {}, close() {} } });
        expect(rs.bytesRead).toBe(0);
        expect(rs.path).toBe('/x');
        expect(rs.pending).toBe(true);
        expect(h.getRetained()).toBe(0);
      } finally {
        h.close();
      }
    });

    it('implements fchmod/fchmodSync, watchFile/unwatchFile, and fs/promises.{realpath,rmdir,lchmod,watch}', async () => {
      const h = makeMockFsHarness();
      try {
        const openSync = h.fs.openSync as (p: string, flags: string) => number;
        const closeSync = h.fs.closeSync as (fd: number) => void;
        const fchmodSync = h.fs.fchmodSync as (fd: number, mode: number) => void;
        const fchmod = h.fs.fchmod as (
          fd: number,
          mode: number,
          cb: (err: unknown) => void,
        ) => void;

        const fd = openSync('/work/item.txt', 'r+');
        fchmodSync(fd, 0o600);
        expect(h.files.get('/work/item.txt')!.mode & 0o777).toBe(0o600);
        await new Promise<void>((resolve, reject) =>
          fchmod(fd, 0o640, (err) => (err ? reject(err) : resolve())),
        );
        expect(h.files.get('/work/item.txt')!.mode & 0o777).toBe(0o640);
        closeSync(fd);
        expect(() => fchmodSync(fd, 0o644)).toThrow(/EBADF/);

        // watchFile / unwatchFile
        const watchFile = h.fs.watchFile as (
          p: string,
          opts: { interval: number; persistent?: boolean },
          listener: (curr: { mtimeMs: number }, prev: { mtimeMs: number }) => void,
        ) => { unref(): unknown; ref(): unknown };
        const unwatchFile = h.fs.unwatchFile as (
          p: string,
          listener?: (...a: never[]) => void,
        ) => void;

        let changedEvent: [number, number] | undefined;
        const statWatcher = watchFile(
          '/work/item.txt',
          { interval: 10, persistent: false },
          (curr, prev) => {
            changedEvent = [curr.mtimeMs, prev.mtimeMs];
          },
        );
        expect(typeof statWatcher.ref).toBe('function');
        expect(typeof statWatcher.unref).toBe('function');
        h.files.get('/work/item.txt')!.mtimeMs = 1700000099000;
        await new Promise((r) => setTimeout(r, 30));
        unwatchFile('/work/item.txt');
        expect(changedEvent).toEqual([1700000099000, 1700000001000]);

        // fs/promises: realpath, rmdir, lchmod, watch
        expect(await (h.fsp.realpath as (p: string) => Promise<string>)('/work/item.txt')).toBe(
          '/work/item.txt',
        );
        await expect(
          (h.fsp.lchmod as (p: string, m: number) => Promise<void>)('/work/item.txt', 0o600),
        ).rejects.toMatchObject({ code: 'ERR_METHOD_NOT_IMPLEMENTED' });

        h.files.set('/work/empty', { mode: 0o040755, content: new Uint8Array(0), mtimeMs: 1 });
        await (h.fsp.rmdir as (p: string) => Promise<void>)('/work/empty');
        expect(h.files.has('/work/empty')).toBe(false);

        const ac = new AbortController();
        const iter = (
          h.fsp.watch as (
            p: string,
            opts?: object,
          ) => AsyncIterable<{ eventType: string; filename: string | Buffer | null }>
        )('/work', { signal: ac.signal })[Symbol.asyncIterator]();
        const nextPromise = iter.next();
        h.watchChannel.port1.postMessage({
          version: VERSION,
          type: 'watch',
          id: h.getLastWatchId(),
          event: 'change',
          filename: 'item.txt',
        });
        const first = await nextPromise;
        expect(first).toEqual({
          done: false,
          value: { eventType: 'change', filename: 'item.txt' },
        });
        const abortedNext = iter.next();
        ac.abort();
        await expect(abortedNext).rejects.toMatchObject({ code: 'ABORT_ERR' });
      } finally {
        h.close();
      }
    });
  });
});
