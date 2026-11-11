import { parse } from 'es-module-lexer/js';
import {
  HEADER_BYTES,
  REPLY_OK,
  REPLY_TOO_LARGE,
  createReplyBuffer,
  replyTooLarge,
  sourceTooLarge,
} from './context-compiler-buffer';
import { createLoweredMarks, markLowered } from './context-lowered';
import { prepareContextSource, prepareModuleSource } from './context-source';
import { type ScriptOrigin, createScriptMaps, formatStack } from './context-stack';
import { decoder, encoder, fault } from './protocol';
import { resourceLimits } from './resource-policy';

/** What compiled module bodies call; implemented by the process's async context. */
export interface ModuleRuntime {
  define(id: number, topLevelAwait: boolean): void;
  enter(id: number): void;
  leave(id: number): void;
  suspend(value: unknown): unknown;
  resume(suspension: never): unknown;
  forAwait(iterable: unknown): unknown;
}

/**
 * `generated` marks eval and Function source; `module` is an ESM body's loader
 * id; `script` is the name the engine will report for this code in a stack
 * frame, with the lines the loader's own wrapper puts before it.
 */
export interface CompileOptions {
  generated?: boolean;
  module?: number;
  script?: { name: string; lineOffset: number };
}

/** Prefix of the global the compiled source calls; vm context scopes let it through. */
export const CONTEXT_HELPER_PREFIX = '__contextEval_';

/** A process owns its compiler Worker. A timed-out channel is never reused. */
export async function createContextCompiler(modules: ModuleRuntime) {
  const worker = new Worker(new URL('context-compiler-worker.js', import.meta.url), {
    type: 'module',
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(fault('ETIMEDOUT', 'Context compiler initialization timed out'));
    }, resourceLimits().timers.contextCompilerMs);
    worker.onmessage = (event) => {
      clearTimeout(timer);
      if (event.data === 'ready') resolve();
      else {
        worker.terminate();
        reject(fault('EIO', String(event.data)));
      }
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      reject(fault('EIO', 'Context compiler Worker failed'));
    };
  });
  let failed = false;
  const { contextSourceBytes: sourceLimit, contextOutputBytes: outputLimit } =
    resourceLimits().modules;
  // Starts at 1 MiB of reply capacity; the compiler Worker grows it on demand.
  const shared = createReplyBuffer(outputLimit);
  const header = new Int32Array(shared, 0, 2);
  // Frames in scripts the loader names are reported at their original positions.
  // A guest that assigns its own Error.prepareStackTrace replaces this.
  const scripts = createScriptMaps(resourceLimits().modules.contextSourceMapBytes);
  Object.defineProperty(Error, 'prepareStackTrace', {
    configurable: true,
    writable: true,
    value: (error: unknown, sites: Parameters<typeof formatStack>[1]) =>
      formatStack(error, sites, scripts.locate),
  });
  const helper = CONTEXT_HELPER_PREFIX + crypto.randomUUID().replaceAll('-', '');
  const mark = helper + '_await';
  const marked = new RegExp(mark + ',\\s*', 'g');
  const nativeEval = globalThis.eval;
  Object.defineProperty(globalThis, helper, {
    value: Object.assign(
      (callee: unknown, value: unknown) =>
        callee === nativeEval && typeof value === 'string'
          ? compile(value, 'eval', { generated: true })
          : value,
      {
        indirect: (value: unknown) =>
          typeof value === 'string'
            ? nativeEval(compile(value, 'eval', { generated: true }))
            : value,
        // Generated code has no loader-owned referrer, and the engine's own
        // import() would fetch relative to the process Worker script.
        import: () =>
          Promise.reject(
            fault('ENOSYS', 'Dynamic import inside eval or Function code is not implemented'),
          ),
        ...createLoweredMarks(helper),
        m: modules.enter,
        l: modules.leave,
        s: modules.suspend,
        r: modules.resume,
        f: modules.forAwait,
      },
    ),
  });
  function compile(source: string, filename: string, options: CompileOptions = {}): string {
    const compiled = transform(source, filename, options);
    if (options.script)
      scripts.register(options.script.name, compiled.source, {
        lineOffset: options.script.lineOffset,
        firstLineShift: compiled.firstLineShift,
        insertions: compiled.insertions,
      });
    return compiled.source;
  }
  function transform(
    source: string,
    filename: string,
    options: CompileOptions,
  ): { source: string } & Pick<ScriptOrigin, 'firstLineShift' | 'insertions'> {
    if (options.module !== undefined) {
      const prepared = prepareModuleSource(source, helper, mark, options.module);
      modules.define(options.module, prepared.topLevelAwait);
      const compiled = lower(prepared.source, filename, true);
      return {
        source: prepared.topLevelAwait
          ? compiled.source.replace(marked, 'await ')
          : compiled.source,
        firstLineShift: prepared.prologue,
        insertions: compiled.insertions,
      };
    }
    if (options.generated && /\bimport\b/.test(source)) {
      const [imports] = parse(source, filename);
      for (const item of [...imports].reverse())
        if (item.t === 2)
          source = source.slice(0, item.ss) + helper + '.import' + source.slice(item.d);
    }
    return { ...lower(source, filename, false), firstLineShift: 0 };
  }
  function lower(
    source: string,
    filename: string,
    module: boolean,
  ): { source: string } & Pick<ScriptOrigin, 'insertions'> {
    if (!/\b(?:async|await|eval)\b/.test(source)) return { source };
    checkSource(source);
    source = prepareContextSource(source, helper);
    if (!/\b(?:async|await)\b/.test(source)) return { source };
    checkSource(source);
    if (failed) throw fault('EPIPE', 'Context compiler is unavailable');
    Atomics.store(header, 0, 0);
    worker.postMessage({ source, filename, shared, sourceLimit, outputLimit });
    if (Atomics.wait(header, 0, 0, resourceLimits().timers.contextCompilerMs) === 'timed-out') {
      failed = true;
      worker.terminate();
      throw fault('ETIMEDOUT', 'Context compiler timed out');
    }
    const status = Atomics.load(header, 0);
    const length = Atomics.load(header, 1);
    if (status === REPLY_TOO_LARGE) throw replyTooLarge(outputLimit, length);
    // A view made now covers whatever length the Worker grew the buffer to.
    const result = decoder.decode(new Uint8Array(shared, HEADER_BYTES, length).slice());
    if (status !== REPLY_OK) throw fault('ENOSYS', result);
    return markLowered(result, source, helper, module);
  }
  function checkSource(source: string) {
    const actual = encoder.encode(source).length;
    if (actual > sourceLimit) throw sourceTooLarge(sourceLimit, actual);
  }
  return compile;
}
