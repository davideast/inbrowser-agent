import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import * as nodeAssertStrict from 'node:assert/strict';
import * as nodeUtil from 'node:util';
import { describe, expect, it } from 'vitest';
import { createStreamBuiltins } from '../../src/builtins/stream';
import {
  type TestRunnerBuiltinsDeps,
  registerTestRunnerBuiltins,
} from '../../src/builtins/test-runner';
import { parseExecArgv } from '../../src/exec-argv';
import { createFs } from '../../src/fs';
import { createLoader } from '../../src/loader';
import {
  CAPACITY,
  HEADER_BYTES,
  Syscalls,
  createSyscallResponder,
  fault,
} from '../../src/protocol';
import { installNodeStream } from '../../src/stream-module';

function expectErrorCode(fn: () => unknown, code?: string, name = 'TypeError'): Error {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  // Invariant: expect(caught).toBeInstanceOf(Error) narrowed caught to Error above.
  const error = caught as Error & { code?: string };
  expect(error.name).toBe(name);
  if (code !== undefined) {
    expect(error.code).toBe(code);
  }
  return error;
}

describe('Slice 1: Web <-> Node Stream Interop', () => {
  it('installs ReadableStream.from on globalThis.ReadableStream and stream/web with Node 22.18 semantics', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis.ReadableStream, 'from');
    Reflect.deleteProperty(globalThis.ReadableStream, 'from');
    try {
      installNodeStream();
      const builtins = createStreamBuiltins();
      expect(builtins['stream/web'].ReadableStream).toBe(globalThis.ReadableStream);

      const desc = Object.getOwnPropertyDescriptor(globalThis.ReadableStream, 'from');
      expect(desc).toBeDefined();
      expect(desc?.writable).toBe(true);
      expect(desc?.enumerable).toBe(true);
      expect(desc?.configurable).toBe(true);

      // Invariant: ReadableStream.from is defined as a static method returning an async-iterable ReadableStream.
      const fromFn = (
        globalThis.ReadableStream as typeof ReadableStream & {
          from: (iterable: unknown) => ReadableStream<unknown> & AsyncIterable<unknown>;
        }
      ).from;
      expect(typeof fromFn).toBe('function');
      expect(fromFn.name).toBe('from');
      expect(fromFn.length).toBe(1);

      // Sync array, string, and Promise-unwrapping sync iterable
      const fromArray: unknown[] = [];
      for await (const chunk of fromFn(['item-1', 'item-2', null, 0, false])) {
        fromArray.push(chunk);
      }
      expect(fromArray).toEqual(['item-1', 'item-2', null, 0, false]);

      const fromString: unknown[] = [];
      for await (const ch of fromFn('abc')) {
        fromString.push(ch);
      }
      expect(fromString).toEqual(['a', 'b', 'c']);

      const fromPromises: unknown[] = [];
      for await (const item of fromFn([Promise.resolve('p1'), 'p2'])) {
        fromPromises.push(item);
      }
      expect(fromPromises).toEqual(['p1', 'p2']);

      // Async generator
      async function* generateItems() {
        yield { id: 1 };
        await Promise.resolve();
        yield { id: 2 };
      }
      const fromAsync: unknown[] = [];
      for await (const item of fromFn(generateItems())) {
        fromAsync.push(item);
      }
      expect(fromAsync).toEqual([{ id: 1 }, { id: 2 }]);

      // Cancellation forwards reason to iterator.return()
      let cancelReason: unknown = null;
      const cancellable = {
        [Symbol.iterator]() {
          let seq = 0;
          return {
            next() {
              return { value: ++seq, done: false };
            },
            return(reason: unknown) {
              cancelReason = reason;
              return { value: undefined, done: true };
            },
          };
        },
      };
      const rs = fromFn(cancellable);
      const reader = rs.getReader();
      expect(await reader.read()).toEqual({ value: 1, done: false });
      await reader.cancel('user-cancelled');
      expect(cancelReason).toBe('user-cancelled');

      // Error semantics matching Node 22.18.0
      expectErrorCode(() => fromFn(undefined), undefined, 'TypeError');
      expectErrorCode(() => fromFn(null), undefined, 'TypeError');
      expectErrorCode(() => fromFn(42), 'ERR_ARG_NOT_ITERABLE', 'TypeError');
      expectErrorCode(() => fromFn({}), 'ERR_ARG_NOT_ITERABLE', 'TypeError');
    } finally {
      if (saved) {
        Object.defineProperty(globalThis.ReadableStream, 'from', saved);
        installNodeStream();
      }
    }
  });

  it('validates locked ReadableStream in Readable.fromWeb with ERR_INVALID_STATE', () => {
    const { stream } = createStreamBuiltins();
    const locked = new ReadableStream();
    locked.getReader();
    expectErrorCode(() => stream.Readable.fromWeb(locked), 'ERR_INVALID_STATE', 'TypeError');
  });

  it('implements Writable.fromWeb and Writable.toWeb with backpressure, options, and error codes', async () => {
    const { stream } = createStreamBuiltins();
    const { Writable } = stream;

    const fromWebDesc = Object.getOwnPropertyDescriptor(Writable, 'fromWeb');
    const toWebDesc = Object.getOwnPropertyDescriptor(Writable, 'toWeb');
    expect(fromWebDesc).toMatchObject({ writable: true, enumerable: true, configurable: true });
    expect(toWebDesc).toMatchObject({ writable: true, enumerable: true, configurable: true });
    expect(Writable.toWeb.length).toBe(1);

    // Writable.fromWeb: byte mode, decodeStrings: false, objectMode: true, backpressure, signal
    const receivedBytes: string[] = [];
    let gateEntered = false;
    let releaseGate: () => void = () => {};
    const gatedWs = new WritableStream({
      async write(chunk) {
        if (!gateEntered) {
          gateEntered = true;
          await new Promise<void>((resolve) => {
            releaseGate = resolve;
          });
        }
        receivedBytes.push(Buffer.from(chunk).toString('utf8'));
      },
    });
    const nodeW = Writable.fromWeb(gatedWs, { highWaterMark: 2 });
    const firstWriteOk = nodeW.write('hello');
    expect(firstWriteOk).toBe(false);
    const drained = new Promise<void>((resolve) => nodeW.once('drain', resolve));
    // Allow underlying WritableStream.write to enter gate
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gateEntered).toBe(true);
    releaseGate();
    await drained;
    await new Promise<void>((resolve, reject) => {
      nodeW.end(' world', (err?: Error | null) => (err ? reject(err) : resolve()));
    });
    expect(receivedBytes.join('')).toBe('hello world');

    // decodeStrings: false passes raw string through to WritableStream
    const rawStrings: unknown[] = [];
    const rawWs = new WritableStream({
      write(chunk) {
        rawStrings.push(chunk);
      },
    });
    const rawNodeW = Writable.fromWeb(rawWs, { decodeStrings: false });
    rawNodeW.write('plain-text');
    await new Promise<void>((resolve) => rawNodeW.end(resolve));
    expect(rawStrings).toEqual(['plain-text']);

    // objectMode: true
    const objects: unknown[] = [];
    const objWs = new WritableStream({
      write(chunk) {
        objects.push(chunk);
      },
    });
    const objNodeW = Writable.fromWeb(objWs, { objectMode: true });
    objNodeW.write({ key: 'alpha' });
    objNodeW.write({ key: 'beta' });
    await new Promise<void>((resolve) => objNodeW.end(resolve));
    expect(objects).toEqual([{ key: 'alpha' }, { key: 'beta' }]);

    // AbortSignal cancels underlying WritableStream
    let abortedReason: unknown = null;
    const abortWs = new WritableStream({
      abort(reason) {
        abortedReason = reason;
      },
    });
    const ac = new AbortController();
    const sigNodeW = Writable.fromWeb(abortWs, { signal: ac.signal });
    const sigErrorPromise = new Promise<Error & { code?: string }>((resolve) => {
      sigNodeW.once('error', resolve);
    });
    ac.abort(new Error('stop-writable'));
    const sigError = await sigErrorPromise;
    expect(sigError.name).toBe('AbortError');
    expect(sigError.code).toBe('ABORT_ERR');
    expect(abortedReason).toBeInstanceOf(Error);

    // Writable.toWeb: byte mode, backpressure, close, abort, already-closed
    const sinkChunks: string[] = [];
    const targetWritable = new Writable({
      highWaterMark: 4,
      write(chunk: Uint8Array, _enc: string, cb: () => void) {
        setTimeout(() => {
          sinkChunks.push(Buffer.from(chunk).toString('utf8'));
          cb();
        }, 2);
      },
    });
    const webW = Writable.toWeb(targetWritable);
    expect(webW).toBeInstanceOf(WritableStream);
    const writer = webW.getWriter();
    await writer.write(new TextEncoder().encode('part-1:'));
    await writer.write(new TextEncoder().encode('part-2'));
    await writer.close();
    expect(sinkChunks).toEqual(['part-1:', 'part-2']);
    expect(targetWritable.writableFinished).toBe(true);

    // Already-destroyed Writable -> closed WritableStream
    const deadWritable = new Writable({
      write(_c: unknown, _e: string, cb: () => void) {
        cb();
      },
    });
    deadWritable.destroy();
    const deadWeb = Writable.toWeb(deadWritable);
    await expect(deadWeb.getWriter().write(new Uint8Array([1]))).rejects.toThrow(TypeError);

    // Validation errors matching Node 22.18.0
    expectErrorCode(() => Writable.toWeb({}), 'ERR_INVALID_ARG_TYPE');
    expectErrorCode(() => Writable.toWeb(null), 'ERR_INVALID_ARG_TYPE');
    expectErrorCode(() => Writable.fromWeb({}), 'ERR_INVALID_ARG_TYPE');
    expectErrorCode(() => Writable.fromWeb(new WritableStream(), null), 'ERR_INVALID_ARG_TYPE');
    expectErrorCode(
      () => Writable.fromWeb(new WritableStream(), { objectMode: 1 }),
      'ERR_INVALID_ARG_TYPE',
    );
    expectErrorCode(
      () => Writable.fromWeb(new WritableStream(), { decodeStrings: 1 }),
      'ERR_INVALID_ARG_TYPE',
    );
    expectErrorCode(
      () => Writable.fromWeb(new WritableStream(), { signal: {} }),
      'ERR_INVALID_ARG_TYPE',
    );
    const lockedWs = new WritableStream();
    lockedWs.getWriter();
    expectErrorCode(() => Writable.fromWeb(lockedWs), 'ERR_INVALID_STATE');
  });

  it('implements Duplex.fromWeb and Duplex.toWeb with bidirectional streaming and validation', async () => {
    const { stream } = createStreamBuiltins();
    const { Duplex, Readable, Writable } = stream;

    expect(Object.getOwnPropertyDescriptor(Duplex, 'fromWeb')).toMatchObject({
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Object.getOwnPropertyDescriptor(Duplex, 'toWeb')).toMatchObject({
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Duplex.toWeb.length).toBe(1);

    // Duplex.fromWeb over TransformStream
    const upperTransform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        const text = Buffer.from(chunk).toString('utf8').toUpperCase();
        ctrl.enqueue(new TextEncoder().encode(text));
      },
    });
    const nodeDuplex = Duplex.fromWeb({
      readable: upperTransform.readable,
      writable: upperTransform.writable,
    });
    expect(nodeDuplex).toBeInstanceOf(Duplex);
    const outChunks: string[] = [];
    nodeDuplex.on('data', (c: Buffer) => outChunks.push(Buffer.from(c).toString('utf8')));
    nodeDuplex.write('alpha-');
    nodeDuplex.end('beta');
    await new Promise<void>((resolve) => nodeDuplex.once('end', resolve));
    expect(outChunks.join('')).toBe('ALPHA-BETA');

    // allowHalfOpen defaults to false in Duplex.fromWeb: readable EOF closes writable side
    let writableClosedByHalfOpen = false;
    const emptyReadable = new ReadableStream({
      start(ctrl) {
        ctrl.close();
      },
    });
    const trackedWritable = new WritableStream({
      close() {
        writableClosedByHalfOpen = true;
      },
    });
    const halfClosedDuplex = Duplex.fromWeb({
      readable: emptyReadable,
      writable: trackedWritable,
    });
    halfClosedDuplex.resume();
    await new Promise<void>((resolve) => halfClosedDuplex.once('close', resolve));
    expect(writableClosedByHalfOpen).toBe(true);

    // Duplex.toWeb over custom Duplex
    const echoDuplex = new Duplex({
      read() {},
      write(
        this: { push: (v: unknown) => boolean },
        chunk: Uint8Array,
        _enc: string,
        cb: () => void,
      ) {
        this.push(Buffer.from(`[${Buffer.from(chunk).toString('utf8')}]`));
        cb();
      },
      final(this: { push: (v: unknown) => boolean }, cb: () => void) {
        this.push(null);
        cb();
      },
    });
    const pair = Duplex.toWeb(echoDuplex);
    expect(Object.keys(pair)).toEqual(['writable', 'readable']);
    const pairWriter = pair.writable.getWriter();
    await pairWriter.write(new TextEncoder().encode('msg1'));
    await pairWriter.write(new TextEncoder().encode('msg2'));
    await pairWriter.close();
    const echoed = await new Response(pair.readable).text();
    expect(echoed).toBe('[msg1][msg2]');

    // Validation errors matching Node 22.18.0 (including rejecting non-Duplex Readable/Writable)
    expectErrorCode(() => Duplex.toWeb({}), 'ERR_INVALID_ARG_TYPE');
    expectErrorCode(() => Duplex.toWeb(new Readable({ read() {} })), 'ERR_INVALID_ARG_TYPE');
    expectErrorCode(
      () =>
        Duplex.toWeb(
          new Writable({
            write(_c: unknown, _e: string, cb: () => void) {
              cb();
            },
          }),
        ),
      'ERR_INVALID_ARG_TYPE',
    );
    expectErrorCode(() => Duplex.fromWeb(null), 'ERR_INVALID_ARG_TYPE');
    expectErrorCode(() => Duplex.fromWeb({}), 'ERR_INVALID_ARG_TYPE');
    expectErrorCode(
      () => Duplex.fromWeb({ readable: new ReadableStream() }),
      'ERR_INVALID_ARG_TYPE',
    );
    expectErrorCode(
      () => Duplex.fromWeb({ writable: new WritableStream() }),
      'ERR_INVALID_ARG_TYPE',
    );
    expectErrorCode(
      () =>
        Duplex.fromWeb({ readable: new ReadableStream(), writable: new WritableStream() }, null),
      'ERR_INVALID_ARG_TYPE',
    );
    expectErrorCode(
      () =>
        Duplex.fromWeb(
          { readable: new ReadableStream(), writable: new WritableStream() },
          { encoding: 'not-an-encoding' },
        ),
      'ERR_INVALID_ARG_VALUE',
    );
    const lockedR = new ReadableStream();
    lockedR.getReader();
    expectErrorCode(
      () => Duplex.fromWeb({ readable: lockedR, writable: new WritableStream() }),
      'ERR_INVALID_STATE',
    );
    const lockedW = new WritableStream();
    lockedW.getWriter();
    expectErrorCode(
      () => Duplex.fromWeb({ readable: new ReadableStream(), writable: lockedW }),
      'ERR_INVALID_STATE',
    );
  });

  it('implements Writable.prototype[Symbol.asyncDispose] matching Node 22.18 semantics', async () => {
    const { stream } = createStreamBuiltins();
    const { Writable, Duplex, Readable } = stream;

    const desc = Object.getOwnPropertyDescriptor(Writable.prototype, Symbol.asyncDispose);
    expect(desc).toMatchObject({ writable: true, enumerable: true, configurable: true });
    expect(Object.getOwnPropertyDescriptor(Duplex.prototype, Symbol.asyncDispose)).toBeUndefined();
    expect(Duplex.prototype[Symbol.asyncDispose]).toBe(Readable.prototype[Symbol.asyncDispose]);

    // Unfinished Writable: destroys with AbortError, does NOT crash when no error listener, and resolves undefined
    const unfinished = new Writable({
      write(_c: unknown, _e: string, cb: () => void) {
        cb();
      },
    });
    unfinished.write('buffered');
    const result = await unfinished[Symbol.asyncDispose]();
    expect(result).toBeUndefined();
    expect(unfinished.destroyed).toBe(true);

    // Unfinished Writable WITH error listener observes AbortError (ABORT_ERR)
    const observedErrors: Array<Error & { code?: string }> = [];
    const unfinishedObserved = new Writable({
      write(_c: unknown, _e: string, cb: () => void) {
        cb();
      },
    });
    unfinishedObserved.on('error', (e: Error & { code?: string }) => {
      observedErrors.push(e);
    });
    await unfinishedObserved[Symbol.asyncDispose]();
    expect(observedErrors).toHaveLength(1);
    expect(observedErrors[0]?.name).toBe('AbortError');
    expect(observedErrors[0]?.code).toBe('ABORT_ERR');

    // Finished Writable: disposes cleanly with no error emitted
    let finishedErrCalled = false;
    const completed = new Writable({
      write(_c: unknown, _e: string, cb: () => void) {
        cb();
      },
    });
    completed.on('error', () => {
      finishedErrCalled = true;
    });
    await new Promise<void>((resolve) => completed.end('done', resolve));
    await completed[Symbol.asyncDispose]();
    expect(finishedErrCalled).toBe(false);
    expect(completed.destroyed).toBe(true);

    // Pre-destroyed with non-AbortError: asyncDispose rejects with that error
    const broken = new Writable({
      write(_c: unknown, _e: string, cb: () => void) {
        cb();
      },
    });
    broken.on('error', () => {});
    broken.destroy(new Error('disk-full'));
    await expect(broken[Symbol.asyncDispose]()).rejects.toThrow('disk-full');
  });
});

function createLoaderTestHarness(
  files: Record<string, string>,
  realpaths: Record<string, string> = {},
) {
  const dirs = new Set<string>(['/']);
  for (const filePath of Object.keys(files)) {
    let cur = filePath;
    while (cur.includes('/')) {
      const idx = cur.lastIndexOf('/');
      cur = idx <= 0 ? '/' : cur.slice(0, idx);
      dirs.add(cur);
      if (cur === '/') break;
    }
  }
  const shared = new SharedArrayBuffer(HEADER_BYTES + CAPACITY);
  const now = new Date(0);
  const responder = createSyscallResponder(shared, (op, args) => {
    const target = String(args[0] ?? '');
    const mapped = realpaths[target] ?? target;
    if (op === 'fs.statSync' || op === 'fs.lstatSync') {
      if (dirs.has(mapped)) {
        return { mode: 0o040755, size: 0, atime: now, mtime: now, ctime: now, birthtime: now };
      }
      if (Object.hasOwn(files, mapped)) {
        return {
          mode: 0o100644,
          size: files[mapped]!.length,
          atime: now,
          mtime: now,
          ctime: now,
          birthtime: now,
        };
      }
      throw fault('ENOENT', `ENOENT: ${target}`);
    }
    if (op === 'fs.existsSync') {
      return dirs.has(mapped) || Object.hasOwn(files, mapped);
    }
    if (op === 'fs.realpathSync') {
      if (target === '.') return '/';
      if (dirs.has(mapped) || Object.hasOwn(files, mapped)) return mapped;
      throw fault('ENOENT', `ENOENT: ${target}`);
    }
    if (op === 'fs.readFileSync') {
      if (!Object.hasOwn(files, mapped)) throw fault('ENOENT', `ENOENT: ${target}`);
      return files[mapped];
    }
    throw fault('ENOSYS', `Unhandled test syscall ${op}`);
  });
  // Invariant: Syscalls only invokes MessagePort.postMessage(data) synchronously in unit tests.
  const port = {
    postMessage: (data: unknown) => responder.handleMessage(data),
  } as unknown as MessagePort;
  const sys = new Syscalls(port, shared, 500, CAPACITY);
  const fs = createFs(sys, () => '/');
  fs.readFileSync = (filename: unknown) => {
    const key = realpaths[String(filename)] ?? String(filename);
    if (!Object.hasOwn(files, key)) throw fault('ENOENT', `ENOENT: ${String(filename)}`);
    return files[key]!;
  };
  const builtins: Record<string, unknown> = {
    fs: { marker: 'fs' },
    path: { marker: 'path' },
    test: { marker: 'node:test' },
  };
  const globals: Record<string, unknown> = {
    process: { env: {}, cwd: () => '/' },
  };
  const startup = parseExecArgv([]);
  const loader = createLoader(
    fs,
    builtins,
    globals,
    {
      base: 'https://loader-r3.test/',
      cwd: () => '/',
      publish: async () => {},
      retain: () => () => {},
    },
    startup,
  );
  // Invariant: createLoader assigns builtins.module with createRequire, _nodeModulePaths, and _resolveFilename.
  const moduleBuiltin = builtins.module as {
    createRequire: (filename: string | URL) => ((id: string) => unknown) & {
      resolve: ((request: unknown, options?: unknown) => string) & {
        paths: (request: unknown) => string[] | null;
      };
    };
    _nodeModulePaths: (from: string) => string[];
    _resolveFilename: (
      request: unknown,
      parent: unknown,
      isMain?: boolean,
      options?: unknown,
    ) => string;
    _resolveLookupPaths?: (request: unknown, parent: unknown) => string[] | null;
  };
  return { loader, moduleBuiltin };
}

describe('Slice 2: require.resolve.paths and require.resolve(request, { paths })', () => {
  it('supports require.resolve.paths on both createRequire and CJS module-scoped require', () => {
    const { loader, moduleBuiltin } = createLoaderTestHarness({
      '/workspace/app/src/inspector.cjs': `
        module.exports = {
          resolveName: require.resolve.name,
          resolveLength: require.resolve.length,
          pathsDesc: Object.getOwnPropertyDescriptor(require.resolve, 'paths'),
          pathsName: require.resolve.paths && require.resolve.paths.name,
          pathsLength: require.resolve.paths && require.resolve.paths.length,
          fsPaths: require.resolve.paths('fs'),
          nodeFsPaths: require.resolve.paths('node:fs'),
          nodeTestPaths: require.resolve.paths('node:test'),
          bareTestPaths: require.resolve.paths('test'),
          dgramPaths: require.resolve.paths('dgram'),
          relDot: require.resolve.paths('.'),
          relDotDot: require.resolve.paths('..'),
          relChild: require.resolve.paths('./helper.js'),
          relParent: require.resolve.paths('../shared.js'),
          dotHidden: require.resolve.paths('.hidden-pkg'),
          slashRoot: require.resolve.paths('/'),
          absSpec: require.resolve.paths('/etc/config'),
          barePkg: require.resolve.paths('plugin-item'),
          scopedPkg: require.resolve.paths('@org/plugin/sub'),
          subpathImport: require.resolve.paths('#internal'),
          modulePaths: module.paths,
        };
      `,
    });

    const req = moduleBuiltin.createRequire('/workspace/app/src/entry.js');
    expect(req.resolve.name).toBe('resolve');
    expect(req.resolve.length).toBe(2);
    const crDesc = Object.getOwnPropertyDescriptor(req.resolve, 'paths');
    expect(crDesc).toMatchObject({ writable: true, enumerable: true, configurable: true });
    expect(req.resolve.paths.name).toBe('paths');
    expect(req.resolve.paths.length).toBe(1);

    const expectedNodeModulePaths = [
      '/workspace/app/src/node_modules',
      '/workspace/app/node_modules',
      '/workspace/node_modules',
      '/node_modules',
    ];
    expect(req.resolve.paths('fs')).toBeNull();
    expect(req.resolve.paths('node:fs')).toBeNull();
    expect(req.resolve.paths('node:test')).toBeNull();
    expect(req.resolve.paths('dgram')).toBeNull();
    expect(req.resolve.paths('test')).toEqual(expectedNodeModulePaths);
    expect(req.resolve.paths('node:unknown')).toEqual(expectedNodeModulePaths);
    expect(req.resolve.paths('.')).toEqual(['/workspace/app/src']);
    expect(req.resolve.paths('..')).toEqual(['/workspace/app/src']);
    expect(req.resolve.paths('./sub')).toEqual(['/workspace/app/src']);
    expect(req.resolve.paths('../up')).toEqual(['/workspace/app/src']);
    expect(req.resolve.paths('/')).toEqual(expectedNodeModulePaths);
    expect(req.resolve.paths('/abs/file.js')).toEqual(expectedNodeModulePaths);
    expect(req.resolve.paths('')).toEqual(expectedNodeModulePaths);
    expect(req.resolve.paths('plugin-item')).toEqual(expectedNodeModulePaths);
    expect(req.resolve.paths('@org/plugin/sub')).toEqual(expectedNodeModulePaths);

    expectErrorCode(() => req.resolve.paths(undefined), 'ERR_INVALID_ARG_TYPE');
    expectErrorCode(() => req.resolve.paths(123), 'ERR_INVALID_ARG_TYPE');

    // Verify CJS module-scoped require.resolve.paths matches identically
    const cjsResult = loader.load('/workspace/app/src/inspector.cjs') as Record<string, unknown>;
    expect(cjsResult.resolveName).toBe('resolve');
    expect(cjsResult.resolveLength).toBe(2);
    expect(cjsResult.pathsDesc).toMatchObject({
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(cjsResult.pathsName).toBe('paths');
    expect(cjsResult.pathsLength).toBe(1);
    expect(cjsResult.fsPaths).toBeNull();
    expect(cjsResult.nodeFsPaths).toBeNull();
    expect(cjsResult.nodeTestPaths).toBeNull();
    expect(cjsResult.dgramPaths).toBeNull();
    expect(cjsResult.bareTestPaths).toEqual(expectedNodeModulePaths);
    expect(cjsResult.relDot).toEqual(['/workspace/app/src']);
    expect(cjsResult.relDotDot).toEqual(['/workspace/app/src']);
    expect(cjsResult.relChild).toEqual(['/workspace/app/src']);
    expect(cjsResult.relParent).toEqual(['/workspace/app/src']);
    expect(cjsResult.dotHidden).toEqual(expectedNodeModulePaths);
    expect(cjsResult.slashRoot).toEqual(expectedNodeModulePaths);
    expect(cjsResult.absSpec).toEqual(expectedNodeModulePaths);
    expect(cjsResult.barePkg).toEqual(expectedNodeModulePaths);
    expect(cjsResult.scopedPkg).toEqual(expectedNodeModulePaths);
    expect(cjsResult.subpathImport).toEqual(expectedNodeModulePaths);
  });

  it('resolves bare, scoped, exports-map, and relative requests across custom options.paths on both createRequire and CJS require', () => {
    const { loader, moduleBuiltin } = createLoaderTestHarness(
      {
        '/tooling/runner/loader.cjs': `
          module.exports = {
            pluginPath: require.resolve('postcss-item', { paths: ['/projects/empty', '/projects/site/sub'] }),
            scopedPath: require.resolve('@acme/preset/theme', { paths: ['/projects/site'] }),
            relConfig: require.resolve('./site.config.cjs', { paths: ['/projects/empty', '/projects/site'] }),
            builtinWithEmptyPaths: require.resolve('fs', { paths: [] }),
          };
        `,
        '/projects/site/node_modules/postcss-item/package.json': JSON.stringify({
          name: 'postcss-item',
          main: './dist/index.js',
        }),
        '/projects/site/node_modules/postcss-item/dist/index.js': 'module.exports = 1;',
        '/projects/site/node_modules/@acme/preset/package.json': JSON.stringify({
          name: '@acme/preset',
          exports: {
            './theme': './cjs/theme.cjs',
          },
        }),
        '/projects/site/node_modules/@acme/preset/cjs/theme.cjs': 'module.exports = 2;',
        '/projects/site/site.config.cjs': 'module.exports = {};',
        '/projects/empty/.keep': '',
        '/real-store/pkg-sym/index.js': 'module.exports = 3;',
      },
      {
        '/projects/site/node_modules/pkg-sym/index.js': '/real-store/pkg-sym/index.js',
      },
    );

    const req = moduleBuiltin.createRequire('/tooling/runner/entry.js');
    // Without custom paths, postcss-item is unreachable from /tooling/runner
    expectErrorCode(() => req.resolve('postcss-item'), 'MODULE_NOT_FOUND', 'Error');

    // With custom options.paths, searches each directory in order
    expect(req.resolve('postcss-item', { paths: ['/projects/empty', '/projects/site/sub'] })).toBe(
      '/projects/site/node_modules/postcss-item/dist/index.js',
    );
    expect(req.resolve('@acme/preset/theme', { paths: ['/projects/site'] })).toBe(
      '/projects/site/node_modules/@acme/preset/cjs/theme.cjs',
    );
    expect(req.resolve('./site.config.cjs', { paths: ['/projects/empty', '/projects/site'] })).toBe(
      '/projects/site/site.config.cjs',
    );
    expect(req.resolve('pkg-sym/index.js', { paths: ['/projects/site'] })).toBe(
      '/real-store/pkg-sym/index.js',
    );

    // Core builtin ignores options.paths
    expect(req.resolve('fs', { paths: [] })).toBe('fs');
    expect(req.resolve('node:test', { paths: [] })).toBe('node:test');

    // Empty paths array throws MODULE_NOT_FOUND
    expectErrorCode(() => req.resolve('postcss-item', { paths: [] }), 'MODULE_NOT_FOUND', 'Error');
    expectErrorCode(
      () => req.resolve('./site.config.cjs', { paths: [] }),
      'MODULE_NOT_FOUND',
      'Error',
    );

    // Argument validation matching Node 22.18.0
    expectErrorCode(() => req.resolve(undefined), 'ERR_INVALID_ARG_TYPE');
    expectErrorCode(() => req.resolve(42), 'ERR_INVALID_ARG_TYPE');
    expectErrorCode(
      () => req.resolve('postcss-item', { paths: 'not-an-array' }),
      'ERR_INVALID_ARG_VALUE',
    );
    expectErrorCode(() => req.resolve('postcss-item', { paths: [123] }), 'ERR_INVALID_ARG_TYPE');
    expectErrorCode(
      () => req.resolve('./site.config.cjs', { paths: [123] }),
      'ERR_INVALID_ARG_TYPE',
    );

    // CJS module-scoped require.resolve(request, { paths })
    const cjsOut = loader.load('/tooling/runner/loader.cjs') as Record<string, unknown>;
    expect(cjsOut).toEqual({
      pluginPath: '/projects/site/node_modules/postcss-item/dist/index.js',
      scopedPath: '/projects/site/node_modules/@acme/preset/cjs/theme.cjs',
      relConfig: '/projects/site/site.config.cjs',
      builtinWithEmptyPaths: 'fs',
    });
  });
});

function createUnitTestRunnerEnv(virtualFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(virtualFiles));
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let retained = 0;
  const idleResolvers: Array<() => void> = [];
  const processObj = Object.assign(new EventEmitter(), {
    exitCode: undefined as number | undefined,
    execArgv: [] as string[],
    argv: ['node'],
    version: 'v22.18.0',
    stdout: {
      isTTY: false,
      write(chunk: string) {
        stdoutChunks.push(String(chunk));
        return true;
      },
    },
    stderr: {
      isTTY: false,
      write(chunk: string) {
        stderrChunks.push(String(chunk));
        return true;
      },
    },
  });
  const target: Record<string, unknown> = {};
  const streamBuiltins = createStreamBuiltins();
  const deps: TestRunnerBuiltinsDeps = {
    process: processObj,
    fs: {
      existsSync: (p: string) => files.has(p),
      readFileSync: (p: string) => {
        const val = files.get(p);
        if (val === undefined) throw fault('ENOENT', `ENOENT: ${p}`);
        return val;
      },
      writeFileSync: (p: string, data: string) => {
        files.set(p, String(data));
      },
      mkdirSync: () => {},
      statSync: (p: string) => {
        if (files.has(p)) return { isFile: () => true, isDirectory: () => false };
        throw fault('ENOENT', `ENOENT: ${p}`);
      },
      readdirSync: () => [],
    },
    cwd: () => '/work',
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    setInterval: (fn, delay, ...args) =>
      globalThis.setInterval(fn, typeof delay === 'number' ? delay : 1, ...args),
    clearInterval: (timer) => globalThis.clearInterval(timer as ReturnType<typeof setInterval>),
    setImmediate: (fn, ...args) => globalThis.setImmediate(fn, ...args),
    clearImmediate: (timer) => globalThis.clearImmediate(timer as ReturnType<typeof setImmediate>),
    hrtimeNs: () => process.hrtime.bigint(),
    retain: () => {
      retained += 1;
    },
    release: () => {
      retained -= 1;
      if (retained === 0) {
        while (idleResolvers.length > 0) idleResolvers.shift()?.();
      }
    },
    loadModule: (id: string) => {
      const virtualCode = files.get(id);
      if (virtualCode !== undefined) {
        const fn = new Function('require', virtualCode);
        fn((reqId: string) => deps.loadModule(reqId));
        return {};
      }
      const bare = id.startsWith('node:') ? id.slice(5) : id;
      if (bare === 'assert/strict' || bare === 'assert') return nodeAssertStrict;
      if (bare in target) return target[bare];
      throw new Error(`Unexpected loadModule(${id})`);
    },
    importModule: async (specifier: string) => {
      const code = files.get(specifier);
      if (code !== undefined) {
        const fn = new Function('require', code);
        fn((id: string) => deps.loadModule(id));
        return {};
      }
      throw new Error(`Missing virtual test file ${specifier}`);
    },
    events: EventEmitter,
    stream: streamBuiltins.stream,
    util: nodeUtil as unknown as Record<string, unknown>,
    asyncHooks: {},
  };
  registerTestRunnerBuiltins(target, deps);
  // Invariant: registerTestRunnerBuiltins installs the node:test module export on target.test.
  const testMod = target.test as {
    (name: string, fn: (t: Record<string, unknown>) => unknown): Promise<void>;
    describe: (name: string, fn: () => unknown) => Promise<void>;
    beforeEach: (fn: () => unknown) => void;
    afterEach: (fn: () => unknown) => void;
    run: (opts: { files: string[]; isolation?: 'none' | 'process' }) => AsyncIterable<{
      type: string;
      data: Record<string, unknown>;
    }>;
  };
  return {
    testMod,
    processObj,
    waitForIdle: async () => {
      if (retained === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (retained === 0) return;
      }
      await new Promise<void>((resolve) => idleResolvers.push(resolve));
    },
  };
}

describe('Slice 3: node:test TestContext#before (t.before()) Subtest Hook Execution', () => {
  it('executes sync, async, and callback t.before hooks in exact Node 22.18 order across nested subtests', async () => {
    const { testMod, processObj, waitForIdle } = createUnitTestRunnerEnv();
    const order: string[] = [];

    await testMod.describe('outer-suite', () => {
      testMod.beforeEach(() => {
        order.push('suite:beforeEach');
      });
      testMod.afterEach(() => {
        order.push('suite:afterEach');
      });

      void testMod('parent-test', async (rawT) => {
        const t = rawT as {
          before: (
            fn: (ctx: unknown, done?: (err?: unknown) => void) => unknown,
            options?: Record<string, unknown>,
          ) => void;
          beforeEach: (fn: () => unknown) => void;
          afterEach: (fn: () => unknown) => void;
          after: (fn: () => unknown) => void;
          test: (name: string, fn: (sub: Record<string, unknown>) => unknown) => Promise<void>;
        };
        order.push('parent:start');
        t.before(async () => {
          order.push('t.before1:sync');
          await new Promise((r) => setTimeout(r, 12));
          order.push('t.before1:async');
        });
        t.before((_ctx, done) => {
          order.push('t.before2:cb-sync');
          setTimeout(() => {
            order.push('t.before2:cb-done');
            done?.();
          }, 4);
        });
        t.beforeEach(() => {
          order.push('t.beforeEach');
        });
        t.afterEach(() => {
          order.push('t.afterEach');
        });
        t.after(() => {
          order.push('t.after');
        });

        order.push('parent:before-sub1');
        await t.test('sub1', async (rawS1) => {
          const s1 = rawS1 as {
            before: (fn: () => unknown) => void;
            test: (name: string, fn: () => unknown) => Promise<void>;
          };
          order.push('sub1:start');
          s1.before(() => {
            order.push('s1.before');
          });
          await s1.test('grandchild', () => {
            order.push('grandchild:body');
          });
        });

        order.push('parent:between-subs');
        t.before(() => {
          order.push('t.before3:late');
        });

        await t.test('sub2', () => {
          order.push('sub2:body');
        });
        order.push('parent:end');
      });

      void testMod('leaf-with-before', (rawLeaf) => {
        const leaf = rawLeaf as { before: (fn: () => unknown) => void };
        leaf.before(() => {
          order.push('leaf:before-sync');
        });
        order.push('leaf:body');
      });
    });

    await waitForIdle();
    expect(processObj.exitCode).toBeUndefined();
    expect(order).toEqual([
      'suite:beforeEach',
      'parent:start',
      't.before1:sync',
      't.before2:cb-sync',
      'parent:before-sub1',
      't.before2:cb-done',
      't.before1:async',
      'suite:beforeEach',
      't.beforeEach',
      'sub1:start',
      's1.before',
      'suite:beforeEach',
      't.beforeEach',
      'grandchild:body',
      't.afterEach',
      'suite:afterEach',
      't.afterEach',
      'suite:afterEach',
      'parent:between-subs',
      't.before3:late',
      'suite:beforeEach',
      't.beforeEach',
      'sub2:body',
      't.afterEach',
      'suite:afterEach',
      'parent:end',
      'suite:afterEach',
      't.after',
      'suite:beforeEach',
      'leaf:before-sync',
      'leaf:body',
      'suite:afterEach',
    ]);
  });

  it('propagates sync and async t.before failures to child subtests as hookFailed and parent as testCodeFailure while running t.after', async () => {
    const cleanupSeen: string[] = [];
    (globalThis as Record<string, unknown>).__r3BeforeCleanupSeen = cleanupSeen;
    try {
      const { testMod } = createUnitTestRunnerEnv({
        '/work/before-failures.cjs': `
          const { test } = require('node:test');
          const seen = globalThis.__r3BeforeCleanupSeen;
          test('parent-sync-fail', async (t) => {
            t.after(() => { seen.push('parent-sync:after'); });
            t.before(() => { throw new Error('sync-boom'); });
            await t.test('sub-a', () => { seen.push('sub-a:body'); });
            await t.test('sub-b', () => { seen.push('sub-b:body'); });
          });
          test('parent-async-fail', async (t) => {
            t.after(() => { seen.push('parent-async:after'); });
            t.before(async () => {
              await new Promise((r) => setTimeout(r, 5));
              throw new Error('async-boom');
            });
            await t.test('sub-c', () => { seen.push('sub-c:body'); });
            await t.test('sub-d', () => { seen.push('sub-d:body'); });
          });
        `,
      });

      const outcomes: Array<{
        type: string;
        name: string;
        nesting: number;
        failureType: unknown;
        causeMessage: unknown;
      }> = [];
      for await (const ev of testMod.run({
        files: ['/work/before-failures.cjs'],
        isolation: 'none',
      })) {
        if (ev.type === 'test:pass' || ev.type === 'test:fail') {
          const details = ev.data.details as
            | { error?: Error & { failureType?: string; cause?: { message?: string } } }
            | undefined;
          outcomes.push({
            type: ev.type,
            name: String(ev.data.name),
            nesting: Number(ev.data.nesting),
            failureType: details?.error?.failureType,
            causeMessage: details?.error?.cause?.message ?? details?.error?.message,
          });
        }
      }

      expect(cleanupSeen).toEqual(['parent-sync:after', 'parent-async:after']);
      expect(outcomes).toEqual([
        {
          type: 'test:fail',
          name: 'sub-a',
          nesting: 1,
          failureType: 'hookFailed',
          causeMessage: 'sync-boom',
        },
        {
          type: 'test:fail',
          name: 'sub-b',
          nesting: 1,
          failureType: 'hookFailed',
          causeMessage: 'sync-boom',
        },
        {
          type: 'test:fail',
          name: 'parent-sync-fail',
          nesting: 0,
          failureType: 'testCodeFailure',
          causeMessage: 'sync-boom',
        },
        {
          type: 'test:fail',
          name: 'sub-c',
          nesting: 1,
          failureType: 'hookFailed',
          causeMessage: 'async-boom',
        },
        {
          type: 'test:fail',
          name: 'sub-d',
          nesting: 1,
          failureType: 'hookFailed',
          causeMessage: 'async-boom',
        },
        {
          type: 'test:fail',
          name: 'parent-async-fail',
          nesting: 0,
          failureType: 'testCodeFailure',
          causeMessage: 'async-boom',
        },
      ]);
    } finally {
      Reflect.deleteProperty(globalThis, '__r3BeforeCleanupSeen');
    }
  });
});
