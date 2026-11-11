import { invalidArgType } from './process-warning';
// `process.report`, after Node 22.18's lib/internal/process/report.js and the report
// format of report.md (reportVersion 5). A browser Worker can describe itself, its
// JavaScript stack and its environment; it has no source for the native sections
// (heap spaces, native stack, rusage, libuv handles, workers, ulimits, shared
// objects) or for the host header fields (OS, CPUs, interfaces, host name, word
// size), so those are omitted rather than invented. Report triggers (fatal error,
// signal, uncaught exception) cannot be armed and fail explicitly.
import { fault } from './protocol';

/** The part of the guest `process` object a report reads. */
export interface ReportProcess {
  pid: number;
  execPath: string;
  execArgv: string[];
  argv: string[];
  version: string;
  versions: Record<string, string>;
  /** Attached after the process object is built (process-metadata.ts). */
  release?: unknown;
  platform: string;
  arch: string;
  env: Record<string, unknown>;
  cwd(): string;
}

export interface ReportHost {
  process: ReportProcess;
  threadId: number;
  /** Writes a whole file, relative to the process cwd; throws the fs error. */
  writeFile(path: string, text: string): void;
  /** Writes to the process's stdout or stderr binding. */
  write(stream: 'stdout' | 'stderr', text: string): void;
}

// POSIX signal names: report.signal accepts a valid name and stores it. Nothing is
// armed, because reportOnSignal cannot be enabled here.
const SIGNALS = new Set(
  (
    'SIGHUP SIGINT SIGQUIT SIGILL SIGTRAP SIGABRT SIGIOT SIGBUS SIGFPE SIGKILL SIGUSR1 ' +
    'SIGSEGV SIGUSR2 SIGPIPE SIGALRM SIGTERM SIGCHLD SIGCONT SIGSTOP SIGTSTP SIGTTIN ' +
    'SIGTTOU SIGURG SIGXCPU SIGXFSZ SIGVTALRM SIGPROF SIGWINCH SIGIO SIGSYS'
  ).split(' '),
);

// Node prints the failing errno number; these are the POSIX values.
const ERRNO: Record<string, number> = {
  ENOENT: 2,
  EACCES: 13,
  EEXIST: 17,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENOSPC: 28,
  EROFS: 30,
};

function validateBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw invalidArgType(name, 'of type boolean', value);
}

function validateString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') throw invalidArgType(name, 'of type string', value);
}

function validateObject(value: unknown, name: string): asserts value is object {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalidArgType(name, 'of type object', value);
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** The `stack` of `err` split as Node's report does: first line, then trimmed frames. */
function javascriptStack(err: object) {
  const errorProperties: Record<string, string> = {};
  for (const key of Object.keys(err)) {
    try {
      errorProperties[key] = String(Reflect.get(err, key));
    } catch {
      errorProperties[key] = '';
    }
  }
  const stack: unknown = Reflect.get(err, 'stack');
  if (typeof stack !== 'string')
    return { message: 'No stack.', stack: ['Unavailable.'], errorProperties };
  const [message, ...frames] = stack.split('\n');
  return {
    message,
    stack: frames.map((line) => line.trim()).filter((line) => line !== ''),
    errorProperties,
  };
}

export function createReport(host: ReportHost) {
  const { process } = host;
  let directory = '';
  let filename = '';
  let compact = false;
  let excludeNetwork = false;
  let excludeEnv = false;
  let signal = 'SIGUSR2';
  let sequence = 0;

  /** Node's ERR_SYNTHETIC, whose stack starts at the caller of `limit`. */
  function synthetic(limit: (...args: never[]) => unknown): Error {
    const error = new Error('JavaScript Callstack');
    // The stack header is formatted from the name when the stack is captured.
    Object.defineProperty(error, 'name', {
      configurable: true,
      writable: true,
      value: 'Error [ERR_SYNTHETIC]',
    });
    Error.captureStackTrace(error, limit);
    // V8 formats the captured stack on first read; read it while the name is set.
    void error.stack;
    Reflect.deleteProperty(error, 'name');
    return Object.assign(error, { code: 'ERR_SYNTHETIC' });
  }

  function build(err: object, trigger: 'GetReport' | 'API', name: string | null, now: Date) {
    const environmentVariables: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (typeof value === 'string') environmentVariables[key] = value;
    return {
      header: {
        reportVersion: 5,
        event: 'JavaScript API',
        trigger,
        filename: name,
        // Node prints local time with a literal Z (report.md, "dumpEventTime").
        dumpEventTime:
          `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
          `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}Z`,
        dumpEventTimeStamp: String(now.getTime()),
        processId: process.pid,
        threadId: host.threadId,
        cwd: process.cwd(),
        commandLine: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
        nodejsVersion: process.version,
        arch: process.arch,
        platform: process.platform,
        componentVersions: { ...process.versions },
        release: process.release,
      },
      javascriptStack: javascriptStack(err),
      ...(excludeEnv ? {} : { environmentVariables }),
    };
  }

  const serialize = (report: object) =>
    compact ? JSON.stringify(report) + '\n' : '\n' + JSON.stringify(report, null, 2) + '\n';

  const triggerSetter = (value: unknown) => {
    validateBoolean(value, 'trigger');
    if (value)
      throw fault('ENOSYS', 'Diagnostic report triggers cannot be armed in a browser Worker');
  };

  const report = {
    writeReport(file?: unknown, err?: unknown): string {
      if (typeof file === 'object' && file !== null) {
        err = file;
        file = undefined;
      } else if (file !== undefined) {
        validateString(file, 'file');
        if (file.includes('\0'))
          throw Object.assign(
            new TypeError(
              "The argument 'path' must be a string, Uint8Array, or URL without null bytes. " +
                `Received '${file.replace(/\0/g, '\\x00')}'`,
            ),
            { code: 'ERR_INVALID_ARG_VALUE' },
          );
      }
      let error: object;
      if (err === undefined) error = synthetic(report.writeReport);
      else {
        validateObject(err, 'err');
        error = err;
      }
      const now = new Date();
      let name = typeof file === 'string' ? file : filename;
      if (!name)
        name =
          `report.${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
          `.${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
          `.${process.pid}.${host.threadId}.${pad(++sequence, 3)}.json`;
      const text = serialize(build(error, 'API', name, now));
      if (name === 'stdout' || name === 'stderr') {
        host.write(name, text);
        // Node does not mix free-form text into a report written to stderr.
        if (name === 'stdout') host.write('stderr', '\nNode.js report completed\n');
        return name;
      }
      try {
        host.writeFile(directory ? `${directory}/${name}` : name, text);
      } catch (error) {
        const code: unknown = Reflect.get(Object(error), 'code');
        const errno: unknown = Reflect.get(Object(error), 'errno');
        const number =
          typeof errno === 'number'
            ? Math.abs(errno)
            : typeof code === 'string'
              ? (ERRNO[code] ?? code)
              : 'unknown';
        host.write(
          'stderr',
          `\nFailed to open Node.js report file: ${name} directory: ${directory || process.cwd()} (errno: ${number})\n`,
        );
        return '';
      }
      host.write('stderr', `\nWriting Node.js report to file: ${name}\nNode.js report completed\n`);
      return name;
    },
    getReport(err?: unknown): object {
      if (err === undefined)
        return build(synthetic(report.getReport), 'GetReport', null, new Date());
      validateObject(err, 'err');
      return build(err, 'GetReport', null, new Date());
    },
    get directory() {
      return directory;
    },
    set directory(value: unknown) {
      validateString(value, 'directory');
      directory = value;
    },
    get filename() {
      return filename;
    },
    set filename(value: unknown) {
      validateString(value, 'filename');
      filename = value;
    },
    get compact() {
      return compact;
    },
    set compact(value: unknown) {
      validateBoolean(value, 'compact');
      compact = value;
    },
    // Accepted and kept; the report has no network section for it to trim.
    get excludeNetwork() {
      return excludeNetwork;
    },
    set excludeNetwork(value: unknown) {
      validateBoolean(value, 'excludeNetwork');
      excludeNetwork = value;
    },
    get signal() {
      return signal;
    },
    set signal(value: unknown) {
      validateString(value, 'signal');
      if (!SIGNALS.has(value)) {
        const upper = value.toUpperCase();
        throw Object.assign(
          new TypeError(
            SIGNALS.has(upper)
              ? `Unknown signal: ${value} (signals must use all capital letters)`
              : `Unknown signal: ${value}`,
          ),
          { code: 'ERR_UNKNOWN_SIGNAL' },
        );
      }
      signal = value;
    },
    get reportOnFatalError() {
      return false;
    },
    set reportOnFatalError(value: unknown) {
      triggerSetter(value);
    },
    get reportOnSignal() {
      return false;
    },
    set reportOnSignal(value: unknown) {
      triggerSetter(value);
    },
    get reportOnUncaughtException() {
      return false;
    },
    set reportOnUncaughtException(value: unknown) {
      triggerSetter(value);
    },
    get excludeEnv() {
      return excludeEnv;
    },
    set excludeEnv(value: unknown) {
      validateBoolean(value, 'excludeEnv');
      excludeEnv = value;
    },
  };
  return report;
}
