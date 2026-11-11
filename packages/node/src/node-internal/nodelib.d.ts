// Ambient module declarations for retained Node.js v22.18.0 `lib/` modules.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

declare module 'internal/nodelib/assert' {
  const assert: ((value: unknown, message?: string | Error) => asserts value) &
    Record<string, unknown>;
  export = assert;
}

declare module 'internal/nodelib/assert/strict' {
  const assertStrict: ((value: unknown, message?: string | Error) => asserts value) &
    Record<string, unknown>;
  export = assertStrict;
}

declare module 'internal/assert/assertion_error' {
  class AssertionError extends Error {
    actual: unknown;
    expected: unknown;
    operator: string | undefined;
    generatedMessage: boolean;
    code: 'ERR_ASSERTION';
    constructor(options: {
      message?: string;
      actual?: unknown;
      expected?: unknown;
      operator?: string;
      stackStartFn?: (...args: never[]) => unknown;
      diff?: 'simple' | 'full';
    });
  }
  export = AssertionError;
}

declare module 'internal/nodelib/util/inspect' {
  export const inspect: ((value: unknown, options?: unknown) => string) & {
    defaultOptions: Record<string, unknown>;
    replDefaults: Record<string, unknown>;
    colors: Record<string, [number, number] | undefined>;
    styles: Record<string, string | undefined>;
    custom: symbol;
  };
  export function format(...args: unknown[]): string;
  export function formatWithOptions(
    inspectOptions: Record<string, unknown>,
    ...args: unknown[]
  ): string;
  export function stripVTControlCharacters(str: string): string;
  export function identicalSequenceRange(a: string[], b: string[]): { len: number; offset: number };
}

declare module 'internal/nodelib/util/comparisons' {
  export function isDeepStrictEqual(val1: unknown, val2: unknown): boolean;
  export function isPartialStrictEqual(val1: unknown, val2: unknown): boolean;
}

declare module 'internal/nodelib/util/diff' {
  export function diff(actual: unknown, expected: unknown): Array<[number, string]>;
}

declare module 'internal/nodelib/util/parse_args/parse_args' {
  export function parseArgs(config?: unknown): {
    values: Record<string, unknown>;
    positionals: string[];
    tokens?: unknown[];
  };
}

declare module 'internal/nodelib/mime' {
  export class MIMEParams {
    constructor();
    delete(name: string): void;
    entries(): IterableIterator<[string, string]>;
    get(name: string): string | null;
    has(name: string): boolean;
    keys(): IterableIterator<string>;
    set(name: string, value: string): void;
    values(): IterableIterator<string>;
    toString(): string;
    toJSON(): string;
    [Symbol.iterator](): IterableIterator<[string, string]>;
  }
  export class MIMEType {
    constructor(input: unknown);
    type: string;
    subtype: string;
    readonly essence: string;
    readonly params: MIMEParams;
    toString(): string;
    toJSON(): string;
  }
}

declare module 'internal/nodelib/events' {
  interface EventEmitterConstructor {
    new (opts?: { captureRejections?: boolean }): Record<string | symbol, unknown>;
    (opts?: { captureRejections?: boolean }): void;
    prototype: Record<string | symbol, unknown>;
    EventEmitter: EventEmitterConstructor;
    EventEmitterAsyncResource: unknown;
    usingDomains: boolean;
    captureRejectionSymbol: symbol;
    captureRejections: boolean;
    errorMonitor: symbol;
    defaultMaxListeners: number;
    readonly kMaxEventTargetListeners: symbol;
    readonly kMaxEventTargetListenersWarned: symbol;
    setMaxListeners: (n?: number, ...eventTargets: unknown[]) => void;
    getMaxListeners: (emitterOrTarget: unknown) => number;
    getEventListeners: (emitterOrTarget: unknown, type: string | symbol) => unknown[];
    listenerCount: (emitter: unknown, type: string | symbol) => number;
    once: (
      emitter: unknown,
      name: string | symbol,
      options?: { signal?: AbortSignal },
    ) => Promise<unknown[]>;
    on: (
      emitter: unknown,
      event: string | symbol,
      options?: {
        signal?: AbortSignal;
        close?: string[];
        highWaterMark?: number;
        highWatermark?: number;
        lowWaterMark?: number;
        lowWatermark?: number;
      },
    ) => AsyncIterableIterator<unknown[]>;
    addAbortListener: (signal: AbortSignal, listener: (event: Event) => void) => Disposable;
    init: (opts?: { captureRejections?: boolean }) => void;
    [key: string | symbol]: unknown;
  }
  const EventEmitter: EventEmitterConstructor;
  export = EventEmitter;
}

declare module 'internal/nodelib/path' {
  interface ParsedPath {
    root: string;
    dir: string;
    base: string;
    ext: string;
    name: string;
  }
  interface FormatInputPathObject {
    root?: string;
    dir?: string;
    base?: string;
    ext?: string;
    name?: string;
  }
  interface PlatformPath {
    resolve(...paths: string[]): string;
    normalize(path: string): string;
    isAbsolute(path: string): boolean;
    join(...paths: string[]): string;
    relative(from: string, to: string): string;
    toNamespacedPath(path: string): string;
    _makeLong(path: string): string;
    dirname(path: string): string;
    basename(path: string, suffix?: string): string;
    extname(path: string): string;
    format(pathObject: FormatInputPathObject): string;
    parse(path: string): ParsedPath;
    matchesGlob(path: string, pattern: string): boolean;
    readonly sep: string;
    readonly delimiter: string;
    readonly posix: PlatformPath;
    readonly win32: PlatformPath;
  }
  const path: PlatformPath;
  export = path;
}

declare module 'internal/nodelib/querystring' {
  interface ParseOptions {
    maxKeys?: number;
    decodeURIComponent?: (str: string) => string;
  }
  interface StringifyOptions {
    encodeURIComponent?: (str: string) => string;
  }
  interface QueryStringModule {
    unescapeBuffer(s: string, decodeSpaces?: boolean): Uint8Array;
    unescape(s: string, decodeSpaces?: boolean): string;
    escape(str: unknown): string;
    stringify(
      obj?: Record<string, unknown>,
      sep?: string,
      eq?: string,
      options?: StringifyOptions,
    ): string;
    encode(
      obj?: Record<string, unknown>,
      sep?: string,
      eq?: string,
      options?: StringifyOptions,
    ): string;
    parse(
      str: string,
      sep?: string,
      eq?: string,
      options?: ParseOptions,
    ): Record<string, string | string[]>;
    decode(
      str: string,
      sep?: string,
      eq?: string,
      options?: ParseOptions,
    ): Record<string, string | string[]>;
  }
  const querystring: QueryStringModule;
  export = querystring;
}

declare module 'internal/nodelib/string_decoder' {
  interface StringDecoderInstance {
    encoding: string;
    write(buf: string | ArrayBufferView): string;
    end(buf?: string | ArrayBufferView): string;
    text(buf: ArrayBufferView, offset?: number): string;
    readonly lastChar: Uint8Array;
    readonly lastNeed: number;
    readonly lastTotal: number;
  }
  interface StringDecoderModule {
    StringDecoder: new (encoding?: string) => StringDecoderInstance;
  }
  const stringDecoder: StringDecoderModule;
  export = stringDecoder;
}

declare module 'internal/nodelib/diagnostics_channel' {
  interface ChannelInstance {
    name: string | symbol;
    readonly hasSubscribers: boolean;
    subscribe(subscription: (message: unknown, name: string | symbol) => void): void;
    unsubscribe(subscription: (message: unknown, name: string | symbol) => boolean): boolean;
    publish(message: unknown): void;
    bindStore(store: unknown, transform?: (message: unknown) => unknown): void;
    unbindStore(store: unknown): boolean;
    runStores(
      context: unknown,
      fn: (...args: unknown[]) => unknown,
      thisArg?: unknown,
      ...args: unknown[]
    ): unknown;
  }
  interface DiagnosticsChannelModule {
    Channel: new (name: string | symbol) => ChannelInstance;
    channel(name: string | symbol): ChannelInstance;
    hasSubscribers(name: string | symbol): boolean;
    subscribe(
      name: string | symbol,
      subscription: (message: unknown, name: string | symbol) => void,
    ): void;
    unsubscribe(
      name: string | symbol,
      subscription: (message: unknown, name: string | symbol) => void,
    ): boolean;
    tracingChannel(nameOrChannels: unknown): unknown;
  }
  const diagnosticsChannel: DiagnosticsChannelModule;
  export = diagnosticsChannel;
}

declare module 'internal/nodelib/readline/interface' {
  export const Interface: {
    new (...args: unknown[]): Record<string | symbol, unknown>;
    prototype: Record<string | symbol, unknown>;
  };
  export const kInsertString: symbol;
  export const kLine_buffer: symbol;
  export const kNormalWrite: symbol;
  export const kOnLine: symbol;
}

declare module 'internal/nodelib/readline/promises' {
  interface ReadlineBatchInstance {
    cursorTo(x: number, y?: number): this;
    moveCursor(dx: number, dy: number): this;
    clearLine(dir: -1 | 0 | 1): this;
    clearScreenDown(): this;
    commit(): Promise<unknown>;
    rollback(): this;
  }
  interface ReadlinePromisesModule {
    Interface: {
      new (...args: unknown[]): Record<string | symbol, unknown>;
      prototype: Record<string | symbol, unknown>;
    };
    Readline: {
      new (stream: unknown, options?: { autoCommit?: boolean }): ReadlineBatchInstance;
      prototype: ReadlineBatchInstance;
    };
    createInterface(...args: unknown[]): Record<string | symbol, unknown>;
  }
  const readlinePromises: ReadlinePromisesModule;
  export = readlinePromises;
}

declare module 'internal/nodelib/readline' {
  interface ReadlineModule {
    Interface: {
      new (...args: unknown[]): Record<string | symbol, unknown>;
      (...args: unknown[]): Record<string | symbol, unknown>;
      prototype: Record<string | symbol, unknown>;
    };
    clearLine(stream: unknown, dir: number, callback?: () => void): boolean;
    clearScreenDown(stream: unknown, callback?: () => void): boolean;
    createInterface(...args: unknown[]): Record<string | symbol, unknown>;
    cursorTo(stream: unknown, x: number, y?: number | (() => void), callback?: () => void): boolean;
    emitKeypressEvents(stream: unknown, iface?: unknown): void;
    moveCursor(stream: unknown, dx: number, dy: number, callback?: () => void): boolean;
    promises: unknown;
  }
  const readline: ReadlineModule;
  export = readline;
}
