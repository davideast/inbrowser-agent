import { abortError, invalidArgType, validateInteger } from './node-errors';
import { record } from './protocol';
// readline/promises after Node.js v22.18.0 lib/readline/promises.js and
// lib/internal/readline/promises.js (Copyright Joyent, Inc. and other Node
// contributors, MIT license): a promise-based `Interface` (question with a
// `signal`), `createInterface`, and the `Readline` batch writer for cursor and
// screen sequences.
//
// The interface is built on this runtime's terminal readline, so it has that
// readline's limits (terminal streams, no completer or history).
import { Interface as TerminalInterface } from './readline-interface';

type NextTick = (callback: () => void) => void;
type Writer = { write(data: string, callback?: (error?: unknown) => void): unknown };

const CSI = {
  clearToLineBeginning: '\x1b[1K',
  clearToLineEnd: '\x1b[0K',
  clearLine: '\x1b[2K',
  clearScreenDown: '\x1b[0J',
};

// Node's isWritable for a Node stream (named apart from the stream module's export), without the stream module: it has a boolean
// `writable` flag that is set, is not destroyed or ended, and is a write()/on() duck.
function isWritableDuck(stream: unknown): boolean {
  if (!record(stream) || typeof stream.writable !== 'boolean') return false;
  return (
    typeof stream.write === 'function' &&
    typeof stream.on === 'function' &&
    stream.writable &&
    stream.destroyed !== true &&
    stream.writableEnded !== true
  );
}

function validateAbortSignal(signal: unknown, name: string) {
  if (
    signal !== undefined &&
    (signal === null || typeof signal !== 'object' || !('aborted' in signal))
  )
    throw invalidArgType(name, 'AbortSignal', signal);
}

interface Pending {
  callback: (answer: string) => void;
  oldPrompt: string;
}

function named<
  T extends (abstract new (...args: never[]) => unknown) | ((...args: never[]) => unknown),
>(fn: T, name: string): T {
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

export function createReadlinePromises(nextTick: NextTick) {
  class Interface extends TerminalInterface {
    #pending: Pending | null = null;
    #reject: ((error: unknown) => void) | undefined;

    constructor(input?: unknown, output?: unknown, completer?: unknown, terminal?: unknown) {
      // Node accepts an options object as the first argument.
      super(record(input) && input.input ? input : { input, output, completer, terminal });
    }

    // A defaulted parameter, as in Node, so `question.length` is 1.
    question(query: unknown, options: unknown = {}): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        let callback = resolve;
        const signal = record(options) ? options.signal : undefined;
        if (signal) {
          validateAbortSignal(signal, 'options.signal');
          const abortSignal = signal as AbortSignal;
          if (abortSignal.aborted)
            return reject(abortError(undefined, { cause: abortSignal.reason }));
          const onAbort = () => {
            this.#cancelQuestion();
            reject(abortError(undefined, { cause: abortSignal.reason }));
          };
          abortSignal.addEventListener('abort', onAbort, { once: true });
          callback = (answer) => {
            abortSignal.removeEventListener('abort', onAbort);
            resolve(answer);
          };
        }
        this.#reject = reject;
        this.#ask(String(query), callback);
      });
    }

    #ask(query: string, callback: (answer: string) => void) {
      if (this.closed)
        throw Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' });
      if (this.#pending) {
        this.prompt();
      } else {
        this.#pending = { callback, oldPrompt: this.getPrompt() };
        this.setPrompt(query);
        this.prompt();
      }
    }

    #cancelQuestion() {
      if (!this.#pending) return;
      this.setPrompt(this.#pending.oldPrompt);
      this.#pending = null;
      this.clearLine();
    }

    // A line answers the pending question instead of being emitted.
    emit(event: string | symbol, ...args: unknown[]): boolean {
      if (event === 'line' && this.#pending) {
        const { callback, oldPrompt } = this.#pending;
        this.#pending = null;
        this.setPrompt(oldPrompt);
        callback(args[0] as string);
        return true;
      }
      return super.emit(event, ...args);
    }

    protected override cancelled(reason: string) {
      this.#reject?.(abortError(reason));
    }
  }
  named(Interface, 'Interface');

  class Readline {
    #autoCommit = false;
    #stream: Writer;
    #todo: string[] = [];

    constructor(stream: unknown, options?: unknown) {
      if (!isWritableDuck(stream)) throw invalidArgType('stream', 'Writable', stream);
      this.#stream = stream as Writer;
      const autoCommit = record(options) ? options.autoCommit : undefined;
      if (autoCommit != null) {
        if (typeof autoCommit !== 'boolean')
          throw invalidArgType('options.autoCommit', 'boolean', autoCommit);
        this.#autoCommit = autoCommit;
      }
    }

    cursorTo(x: unknown, y: unknown = undefined) {
      validateInteger(x, 'x');
      if (y != null) validateInteger(y, 'y');
      const data =
        y == null
          ? `\x1b[${(x as number) + 1}G`
          : `\x1b[${(y as number) + 1};${(x as number) + 1}H`;
      if (this.#autoCommit) nextTick(() => this.#stream.write(data));
      else this.#todo.push(data);
      return this;
    }

    moveCursor(dx: unknown, dy: unknown) {
      if (dx || dy) {
        validateInteger(dx, 'dx');
        validateInteger(dy, 'dy');
        const x = dx as number;
        const y = dy as number;
        let data = '';
        if (x < 0) data += `\x1b[${-x}D`;
        else if (x > 0) data += `\x1b[${x}C`;
        if (y < 0) data += `\x1b[${-y}A`;
        else if (y > 0) data += `\x1b[${y}B`;
        if (this.#autoCommit) nextTick(() => this.#stream.write(data));
        else this.#todo.push(data);
      }
      return this;
    }

    clearLine(dir: unknown) {
      validateInteger(dir, 'dir', -1, 1);
      const data =
        (dir as number) < 0
          ? CSI.clearToLineBeginning
          : (dir as number) > 0
            ? CSI.clearToLineEnd
            : CSI.clearLine;
      if (this.#autoCommit) nextTick(() => this.#stream.write(data));
      else this.#todo.push(data);
      return this;
    }

    clearScreenDown() {
      if (this.#autoCommit) nextTick(() => this.#stream.write(CSI.clearScreenDown));
      else this.#todo.push(CSI.clearScreenDown);
      return this;
    }

    commit(): Promise<unknown> {
      return new Promise<unknown>((resolve) => {
        // Node settles with the write callback's argument, which is null on success
        // (not every stream implementation passes it).
        this.#stream.write(this.#todo.join(''), (error?: unknown) => resolve(error ?? null));
        this.#todo = [];
      });
    }

    rollback() {
      this.#todo = [];
      return this;
    }
  }
  named(Readline, 'Readline');

  const createInterface = named(function createInterface(
    input?: unknown,
    output?: unknown,
    completer?: unknown,
    terminal?: unknown,
  ) {
    return new Interface(input, output, completer, terminal);
  }, 'createInterface');

  return { Interface, Readline, createInterface };
}
