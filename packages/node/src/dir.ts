import { fileURLToPath } from './file-url';
import { fault, record } from './protocol';

type Dirent = Record<string, unknown> & { isDirectory(): boolean };
type Callback = (error: Error | null, value?: unknown) => void;

const closedError = () => fault('ERR_DIR_CLOSED', 'Directory handle was closed');

/**
 * Node 22.18's fs.Dir (lib/internal/fs/dir.js) over the virtual filesystem. The
 * directory is listed once when it is opened; Node reads the host directory in
 * batches, so entries created or removed after opening may differ from native.
 * Recursive directory handles are not provided.
 */
export function createDir(readdir: (path: string, options: object) => unknown) {
  class Dir {
    readonly #path: string;
    #entries: Dirent[];
    #closed = false;

    constructor(path: string, entries: Dirent[]) {
      this.#path = path;
      this.#entries = entries;
    }
    get path() {
      return this.#path;
    }
    #next(): Dirent | null {
      if (this.#closed) throw closedError();
      return this.#entries.shift() ?? null;
    }
    readSync() {
      return this.#next();
    }
    read(callback?: Callback): Promise<Dirent | null> | undefined {
      if (callback === undefined) {
        try {
          return Promise.resolve(this.#next());
        } catch (error) {
          return Promise.reject(error);
        }
      }
      if (typeof callback !== 'function')
        throw fault('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function');
      const entry = this.#next();
      queueMicrotask(() => callback(null, entry));
      return undefined;
    }
    closeSync() {
      if (this.#closed) throw closedError();
      this.#closed = true;
      this.#entries = [];
    }
    close(callback?: Callback): Promise<void> | undefined {
      if (callback === undefined) {
        try {
          this.closeSync();
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      }
      if (typeof callback !== 'function')
        throw fault('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function');
      let failure: Error | null = null;
      try {
        this.closeSync();
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
      queueMicrotask(() => callback(failure));
      return undefined;
    }
    async *entries() {
      try {
        for (;;) {
          const entry = await this.read();
          if (entry === null) break;
          yield entry;
        }
      } finally {
        await this.close();
      }
    }
    [Symbol.asyncIterator]() {
      return this.entries();
    }
    async [Symbol.asyncDispose](): Promise<void> {
      await this.close();
    }
  }

  /** Node reports opendir failures with the opendir syscall; `path` names the target. */
  function opendirFailure(error: unknown, target: string | undefined) {
    if (!record(error) || typeof error.code !== 'string' || error.code.startsWith('ERR_'))
      return error;
    const description =
      typeof error.message === 'string'
        ? (/^[A-Z]+: ([^,]+)/.exec(error.message)?.[1] ?? error.code)
        : error.code;
    error.message =
      `${error.code}: ${description}, opendir` + (target === undefined ? '' : ` '${target}'`);
    error.syscall = 'opendir';
    if (target === undefined) delete error.path;
    else error.path = target;
    return error;
  }

  /**
   * Opens `target` as a Dir. `reportPath` is false for the synchronous form, whose
   * native errors carry no path.
   */
  function opendir(target: unknown, options: unknown, reportPath: boolean) {
    const path = target instanceof URL ? fileURLToPath(target) : target;
    if (typeof path !== 'string')
      throw fault(
        'ERR_INVALID_ARG_TYPE',
        'The "path" argument must be of type string or an instance of Buffer or URL',
      );
    const settings = typeof options === 'string' ? { encoding: options } : (options ?? {});
    if (!record(settings))
      throw fault('ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object');
    const bufferSize = settings.bufferSize ?? 32;
    if (
      typeof bufferSize !== 'number' ||
      !Number.isInteger(bufferSize) ||
      bufferSize < 1 ||
      bufferSize > 0xffffffff
    )
      throw fault('ERR_OUT_OF_RANGE', 'The value of "options.bufferSize" is out of range');
    if (settings.recursive === true)
      throw fault('ENOSYS', 'Recursive directory handles are not implemented');
    let listing: unknown;
    try {
      listing = readdir(path, {
        withFileTypes: true,
        encoding: typeof settings.encoding === 'string' ? settings.encoding : 'utf8',
      });
    } catch (error) {
      throw opendirFailure(error, reportPath ? path : undefined);
    }
    if (!Array.isArray(listing)) throw fault('EPROTO', 'Invalid directory listing');
    // Invariant: readdirSync with withFileTypes returns Dirent records.
    const entries = (listing as Dirent[]).map((entry) =>
      Object.assign(entry, { parentPath: path, path }),
    );
    return new Dir(path, entries);
  }

  return { Dir, opendir };
}
