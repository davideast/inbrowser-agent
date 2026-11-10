import { Writable } from 'stream';
import { invalidArgType, invalidArgValue, nodeError, validateInteger } from '../node-errors';
import type { TerminalDimensions } from '../terminal';
import { fault, record } from '../value-guards';

export interface TtyBuiltinDeps {
  process: {
    stdin: { isTTY?: boolean };
    stdout: {
      isTTY?: boolean;
      columns?: number;
      rows?: number;
      write?: (chunk: unknown) => boolean;
    };
    stderr: {
      isTTY?: boolean;
      columns?: number;
      rows?: number;
      write?: (chunk: unknown) => boolean;
    };
    env: Record<string, unknown>;
    emitWarning?: (warning: string | Error, type?: string, code?: string) => void;
    nextTick?: (cb: (...args: unknown[]) => void, ...args: unknown[]) => void;
  };
  getTerminal: () => TerminalDimensions | undefined;
}

export interface TtyReadStreamInstance {
  isRaw?: boolean;
  isTTY?: boolean;
  setRawMode(flag: boolean): this;
}

export interface TtyReadStreamConstructor {
  new (fd?: number, options?: Record<string, unknown>): TtyReadStreamInstance;
  (fd?: number, options?: Record<string, unknown>): TtyReadStreamInstance;
  readonly prototype: TtyReadStreamInstance;
}

export interface TtyWriteStreamInstance extends Writable {
  fd: number;
  isTTY: boolean;
  columns?: number;
  rows?: number;
  getWindowSize(): [number | undefined, number | undefined];
  getColorDepth(env?: unknown): number;
  hasColors(count?: unknown, env?: unknown): boolean;
  cursorTo(x: number, y?: number | (() => void), callback?: () => void): boolean;
  moveCursor(dx: number, dy: number, callback?: () => void): boolean;
  clearLine(dir: number, callback?: () => void): boolean;
  clearScreenDown(callback?: () => void): boolean;
}

export interface TtyWriteStreamConstructor {
  new (fd?: unknown): TtyWriteStreamInstance;
  (fd?: unknown): TtyWriteStreamInstance;
  readonly prototype: TtyWriteStreamInstance;
}

const COLORS_2 = 1;
const COLORS_16 = 4;
const COLORS_256 = 8;
const COLORS_16M = 24;

const TERM_ENVS: Record<string, number> = {
  eterm: COLORS_16,
  cons25: COLORS_16,
  console: COLORS_16,
  cygwin: COLORS_16,
  dtterm: COLORS_16,
  gnome: COLORS_16,
  hurd: COLORS_16,
  jfbterm: COLORS_16,
  konsole: COLORS_16,
  kterm: COLORS_16,
  mlterm: COLORS_16,
  mosh: COLORS_16M,
  putty: COLORS_16,
  st: COLORS_16,
  'rxvt-unicode-24bit': COLORS_16M,
  terminator: COLORS_16M,
  'xterm-kitty': COLORS_16M,
};

const CI_ENVS: ReadonlyArray<readonly [string, number]> = [
  ['APPVEYOR', COLORS_256],
  ['BUILDKITE', COLORS_256],
  ['CIRCLECI', COLORS_16M],
  ['DRONE', COLORS_256],
  ['GITEA_ACTIONS', COLORS_16M],
  ['GITHUB_ACTIONS', COLORS_16M],
  ['GITLAB_CI', COLORS_256],
  ['TRAVIS', COLORS_256],
];

const TERM_ENVS_REG_EXP = [
  /ansi/,
  /color/,
  /linux/,
  /direct/,
  /^con[0-9]*x[0-9]/,
  /^rxvt/,
  /^screen/,
  /^xterm/,
  /^vt100/,
  /^vt220/,
];

function validateOptionalCallback(
  callback: unknown,
): asserts callback is ((err?: Error | null) => void) | undefined {
  if (callback !== undefined && typeof callback !== 'function') {
    throw invalidArgType('callback', 'Function', callback);
  }
}

export function createTtyBuiltin(deps: TtyBuiltinDeps) {
  let warnedDeactivatedColors = false;

  function warnOnDeactivatedColors(env: Record<string, unknown>): void {
    if (warnedDeactivatedColors) return;
    let name = '';
    if (env.NODE_DISABLE_COLORS !== undefined) name = 'NODE_DISABLE_COLORS';
    if (env.NO_COLOR !== undefined) {
      if (name !== '') name += "' and '";
      name += 'NO_COLOR';
    }
    if (name !== '') {
      deps.process.emitWarning?.(
        `The '${name}' env is ignored due to the 'FORCE_COLOR' env being set.`,
        'Warning',
      );
      warnedDeactivatedColors = true;
    }
  }

  function computeColorDepth(rawEnv: unknown = deps.process.env): number {
    if (!record(rawEnv)) {
      throw invalidArgType('env', 'Object', rawEnv);
    }
    if (rawEnv.FORCE_COLOR !== undefined) {
      switch (rawEnv.FORCE_COLOR) {
        case '':
        case '1':
        case 'true':
          warnOnDeactivatedColors(rawEnv);
          return COLORS_16;
        case '2':
          warnOnDeactivatedColors(rawEnv);
          return COLORS_256;
        case '3':
          warnOnDeactivatedColors(rawEnv);
          return COLORS_16M;
        default:
          return COLORS_2;
      }
    }

    if (
      rawEnv.NODE_DISABLE_COLORS !== undefined ||
      rawEnv.NO_COLOR !== undefined ||
      rawEnv.TERM === 'dumb'
    ) {
      return COLORS_2;
    }

    if (rawEnv.TMUX) return COLORS_16M;

    if (Object.hasOwn(rawEnv, 'TF_BUILD') && Object.hasOwn(rawEnv, 'AGENT_NAME')) {
      return COLORS_16;
    }

    if (Object.hasOwn(rawEnv, 'CI')) {
      for (const [envName, colors] of CI_ENVS) {
        if (Object.hasOwn(rawEnv, envName)) return colors;
      }
      if (rawEnv.CI_NAME === 'codeship') return COLORS_256;
      return COLORS_2;
    }

    if ('TEAMCITY_VERSION' in rawEnv) {
      return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(String(rawEnv.TEAMCITY_VERSION))
        ? COLORS_16
        : COLORS_2;
    }

    switch (rawEnv.TERM_PROGRAM) {
      case 'iTerm.app':
        return !rawEnv.TERM_PROGRAM_VERSION || /^[0-2]\./.test(String(rawEnv.TERM_PROGRAM_VERSION))
          ? COLORS_256
          : COLORS_16M;
      case 'HyperTerm':
      case 'MacTerm':
        return COLORS_16M;
      case 'Apple_Terminal':
        return COLORS_256;
    }

    if (rawEnv.COLORTERM === 'truecolor' || rawEnv.COLORTERM === '24bit') {
      return COLORS_16M;
    }

    if (typeof rawEnv.TERM === 'string' && rawEnv.TERM.length > 0) {
      if (/truecolor/.test(rawEnv.TERM)) return COLORS_16M;
      if (/^xterm-256/.test(rawEnv.TERM)) return COLORS_256;
      const lower = rawEnv.TERM.toLowerCase();
      const mapped = TERM_ENVS[lower];
      if (mapped !== undefined) return mapped;
      if (TERM_ENVS_REG_EXP.some((rx) => rx.test(lower))) return COLORS_16;
    }

    if (rawEnv.COLORTERM) return COLORS_16;
    return COLORS_2;
  }

  function scheduleTick(cb: (err?: Error | null) => void): void {
    if (typeof deps.process.nextTick === 'function') {
      deps.process.nextTick(() => cb(null));
    } else {
      queueMicrotask(() => cb(null));
    }
  }

  function isatty(fd?: unknown): boolean {
    if (typeof fd !== 'number' || !Number.isInteger(fd) || fd < 0 || fd > 2147483647) {
      return false;
    }
    if (fd === 0) {
      return deps.process.stdin?.isTTY !== undefined
        ? Boolean(deps.process.stdin.isTTY)
        : Boolean(deps.getTerminal());
    }
    if (fd === 1) {
      return deps.process.stdout?.isTTY !== undefined
        ? Boolean(deps.process.stdout.isTTY)
        : Boolean(deps.getTerminal());
    }
    if (fd === 2) {
      return deps.process.stderr?.isTTY !== undefined
        ? Boolean(deps.process.stderr.isTTY)
        : Boolean(deps.getTerminal());
    }
    return false;
  }

  function ReadStreamImpl(): never {
    throw fault('ENOSYS', 'Descriptor-based TTY streams are not implemented');
  }
  Object.defineProperty(ReadStreamImpl, 'name', { configurable: true, value: 'ReadStream' });
  ReadStreamImpl.prototype.setRawMode = function setRawMode(
    this: TtyReadStreamInstance,
    flag?: unknown,
  ) {
    this.isRaw = Boolean(flag);
    return this;
  };

  function WriteStreamImpl(this: unknown, fd?: unknown): TtyWriteStreamInstance {
    if (!(this instanceof WriteStreamImpl)) {
      // Invariant: WriteStreamImpl supports invocation without `new` as in Node `tty.WriteStream`.
      return new (WriteStreamImpl as unknown as TtyWriteStreamConstructor)(fd);
    }
    if (typeof fd !== 'number' || fd >> 0 !== fd || fd < 0) {
      throw nodeError(RangeError, 'ERR_INVALID_FD', `"fd" must be a positive integer: ${fd}`);
    }

    // Invariant: `this` inside `new WriteStreamImpl(fd)` is a newly allocated TtyWriteStreamInstance.
    const self = this as TtyWriteStreamInstance;
    Writable.call(self, {
      write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        try {
          if (fd === 1 && typeof deps.process.stdout?.write === 'function') {
            deps.process.stdout.write(chunk);
          } else if (fd === 2 && typeof deps.process.stderr?.write === 'function') {
            deps.process.stderr.write(chunk);
          }
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });

    self.fd = fd;
    const term = deps.getTerminal();
    if (isatty(fd)) {
      const cols =
        fd === 1
          ? (deps.process.stdout?.columns ?? term?.columns)
          : fd === 2
            ? (deps.process.stderr?.columns ?? term?.columns)
            : term?.columns;
      const rows =
        fd === 1
          ? (deps.process.stdout?.rows ?? term?.rows)
          : fd === 2
            ? (deps.process.stderr?.rows ?? term?.rows)
            : term?.rows;
      if (typeof cols === 'number') self.columns = cols;
      if (typeof rows === 'number') self.rows = rows;
    }

    return self;
  }

  Object.defineProperty(WriteStreamImpl, 'name', { configurable: true, value: 'WriteStream' });
  Object.setPrototypeOf(WriteStreamImpl.prototype, Writable.prototype);
  Object.setPrototypeOf(WriteStreamImpl, Writable);

  WriteStreamImpl.prototype.isTTY = true;

  WriteStreamImpl.prototype.getColorDepth = function getColorDepth(env?: unknown) {
    return computeColorDepth(env);
  };

  WriteStreamImpl.prototype.hasColors = function hasColors(
    this: TtyWriteStreamInstance,
    count?: unknown,
    env?: unknown,
  ): boolean {
    let resolvedEnv = env;
    let resolvedCount: number;
    if (
      resolvedEnv === undefined &&
      (count === undefined || (typeof count === 'object' && count !== null))
    ) {
      resolvedEnv = count;
      resolvedCount = 16;
    } else {
      validateInteger(count, 'count', 2);
      if (typeof count !== 'number') throw invalidArgType('count', 'number', count);
      resolvedCount = count;
    }
    const depth =
      resolvedEnv === undefined ? this.getColorDepth() : this.getColorDepth(resolvedEnv);
    return resolvedCount <= 2 ** depth;
  };

  WriteStreamImpl.prototype.getWindowSize = function getWindowSize(
    this: TtyWriteStreamInstance,
  ): [number | undefined, number | undefined] {
    return [this.columns, this.rows];
  };

  WriteStreamImpl.prototype.cursorTo = function cursorTo(
    this: TtyWriteStreamInstance,
    x?: unknown,
    y?: unknown,
    callback?: unknown,
  ): boolean {
    let cb = callback;
    let row = y;
    if (cb !== undefined) validateOptionalCallback(cb);
    if (typeof row === 'function') {
      cb = row;
      row = undefined;
    }
    validateOptionalCallback(cb);

    if (typeof x === 'number' && Number.isNaN(x)) {
      throw invalidArgValue('x', x);
    }
    if (typeof row === 'number' && Number.isNaN(row)) {
      throw invalidArgValue('y', row);
    }
    if (typeof x !== 'number' && typeof row !== 'number') {
      if (typeof cb === 'function') scheduleTick(cb);
      return true;
    }
    if (typeof x !== 'number') {
      throw nodeError(
        TypeError,
        'ERR_INVALID_CURSOR_POS',
        'Cannot set cursor row without setting its column',
      );
    }
    const data = typeof row !== 'number' ? `\u001b[${x + 1}G` : `\u001b[${row + 1};${x + 1}H`;
    return this.write(data, cb);
  };

  WriteStreamImpl.prototype.moveCursor = function moveCursor(
    this: TtyWriteStreamInstance,
    dx?: unknown,
    dy?: unknown,
    callback?: unknown,
  ): boolean {
    validateOptionalCallback(callback);
    const numDx = typeof dx === 'number' ? dx : 0;
    const numDy = typeof dy === 'number' ? dy : 0;
    if (!(numDx || numDy)) {
      if (typeof callback === 'function') scheduleTick(callback);
      return true;
    }
    let data = '';
    if (numDx < 0) data += `\u001b[${-numDx}D`;
    else if (numDx > 0) data += `\u001b[${numDx}C`;
    if (numDy < 0) data += `\u001b[${-numDy}A`;
    else if (numDy > 0) data += `\u001b[${numDy}B`;
    return this.write(data, callback);
  };

  WriteStreamImpl.prototype.clearLine = function clearLine(
    this: TtyWriteStreamInstance,
    dir?: unknown,
    callback?: unknown,
  ): boolean {
    validateOptionalCallback(callback);
    const numDir = Number(dir);
    const seq = numDir < 0 ? '\u001b[1K' : numDir > 0 ? '\u001b[0K' : '\u001b[2K';
    return this.write(seq, callback);
  };

  WriteStreamImpl.prototype.clearScreenDown = function clearScreenDown(
    this: TtyWriteStreamInstance,
    callback?: unknown,
  ): boolean {
    validateOptionalCallback(callback);
    return this.write('\u001b[0J', callback);
  };

  return {
    isatty,
    // Invariant: ReadStreamImpl and WriteStreamImpl satisfy Node 22.18.0 tty constructor and prototype descriptors.
    ReadStream: ReadStreamImpl as unknown as TtyReadStreamConstructor,
    // Invariant: WriteStreamImpl inherits from stream.Writable and implements TtyWriteStreamInstance methods.
    WriteStream: WriteStreamImpl as unknown as TtyWriteStreamConstructor,
  };
}
