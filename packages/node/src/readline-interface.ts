import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder/';
import { fault, record } from './protocol';
import { resourceLimits } from './resource-policy';

type Input = Pick<EventEmitter, 'on' | 'removeListener'> & {
  resume(): unknown;
  pause(): unknown;
  setRawMode(raw: boolean): unknown;
};
type Output = Pick<EventEmitter, 'on' | 'removeListener'> & {
  write(value: string): unknown;
  columns?: number;
  isTTY?: boolean;
};

function isInput(value: unknown): value is Input {
  return (
    record(value) &&
    ['on', 'removeListener', 'resume', 'pause', 'setRawMode'].every(
      (method) => typeof value[method] === 'function',
    )
  );
}
function isOutput(value: unknown): value is Output {
  return (
    record(value) &&
    ['on', 'removeListener', 'write'].every((method) => typeof value[method] === 'function') &&
    (value.columns === undefined ||
      (typeof value.columns === 'number' &&
        Number.isInteger(value.columns) &&
        value.columns > 0)) &&
    (value.isTTY === undefined || typeof value.isTTY === 'boolean')
  );
}

function terminalStreams(options: unknown): {
  input: Input;
  output: Output;
  crlfDelay: number;
  prompt: string;
} {
  if (!record(options) || !isInput(options.input) || !isOutput(options.output))
    throw fault('ERR_INVALID_ARG_TYPE', 'readline requires input and output streams');
  const { input, output } = options;
  if (!(options.terminal ?? output.isTTY))
    throw fault('ENOSYS', 'Nonterminal readline is not implemented');
  if (options.completer !== undefined || options.history !== undefined)
    throw fault('ENOSYS', 'Configured readline completion and history are not implemented');
  if (options.crlfDelay !== undefined && typeof options.crlfDelay !== 'number')
    throw fault('ERR_INVALID_ARG_TYPE', 'crlfDelay must be a number');
  if (options.prompt !== undefined && typeof options.prompt !== 'string')
    throw fault('ERR_INVALID_ARG_TYPE', 'prompt must be a string');
  return {
    input,
    output,
    crlfDelay: Math.max(100, options.crlfDelay ?? 100),
    prompt: options.prompt ?? '> ',
  };
}

export class Interface extends EventEmitter {
  readonly input: Input;
  readonly output: Output;
  readonly terminal = true;
  line = '';
  cursor = 0;
  closed: true | undefined;
  private promptText: string;
  private previousRows = 0;
  private escape = '';
  private returnedAt: number | undefined;
  private readonly crlfDelay: number;
  private readonly decoder = new StringDecoder('utf8');

  constructor(options: unknown) {
    super();
    const streams = terminalStreams(options);
    this.input = streams.input;
    this.output = streams.output;
    this.crlfDelay = streams.crlfDelay;
    this.promptText = streams.prompt;
    this.input.setRawMode(true);
    this.input.on('data', this.receive);
    this.input.on('end', this.end);
    this.input.on('error', this.fail);
    this.output.on('resize', this.resize);
    this.input.resume();
  }

  setPrompt(prompt: string) {
    this.promptText = prompt;
  }

  getPrompt() {
    return this.promptText;
  }

  /** Ends the current line on the output and starts an empty one (Node's rl.clearLine). */
  clearLine() {
    this.move(Number.POSITIVE_INFINITY);
    this.output.write('\r\n');
    this.line = '';
    this.cursor = this.previousRows = 0;
  }

  /** Called after Ctrl+C closed an interface that had no SIGINT listener. */
  protected cancelled(_reason: string): void {}

  prompt() {
    if (this.closed) return;
    this.input.resume();
    this.cursor = 0;
    this._refreshLine();
  }

  private position(text: string) {
    // This first terminal tracer covers printable ASCII display cells only.
    if (/[^\x20-\x7e]/u.test(text))
      throw fault('ENOSYS', 'Non-ASCII readline display width is not implemented');
    const columns = this.output.columns || Number.POSITIVE_INFINITY;
    const cols = text.length % columns;
    return { cols, rows: (text.length - cols) / columns };
  }

  private cursorPosition() {
    return this.position(this.promptText + this.line.slice(0, this.cursor));
  }

  _refreshLine() {
    const text = this.promptText + this.line;
    const end = this.position(text);
    const cursor = this.cursorPosition();
    if (this.previousRows) this.output.write(`\x1b[${this.previousRows}A`);
    this.output.write('\x1b[1G\x1b[0J' + text + (end.cols === 0 ? ' ' : ''));
    this.output.write(`\x1b[${cursor.cols + 1}G`);
    if (end.rows > cursor.rows) this.output.write(`\x1b[${end.rows - cursor.rows}A`);
    this.previousRows = cursor.rows;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.input.pause();
      this.input.setRawMode(false);
    } finally {
      this.input.removeListener('data', this.receive);
      this.input.removeListener('end', this.end);
      this.input.removeListener('error', this.fail);
      this.output.removeListener('resize', this.resize);
      this.emit('close');
    }
  }

  private readonly resize = () => this._refreshLine();
  private readonly end = () => this.close();
  private readonly fail = (error: unknown) => this.emit('error', error);

  private move(delta: number) {
    const old = this.cursorPosition();
    this.cursor = Math.max(0, Math.min(this.line.length, this.cursor + delta));
    const next = this.cursorPosition();
    if (old.rows !== next.rows) this._refreshLine();
    else if (old.cols !== next.cols)
      this.output.write(
        `\x1b[${Math.abs(next.cols - old.cols)}${next.cols < old.cols ? 'D' : 'C'}`,
      );
  }

  private insert(char: string) {
    if (this.line.length >= resourceLimits().child.readlineLineBytes)
      throw fault('E2BIG', 'readline input exceeds 64 KiB');
    const old = this.cursorPosition();
    const middle = this.cursor < this.line.length;
    this.line = this.line.slice(0, this.cursor) + char + this.line.slice(this.cursor);
    this.cursor += char.length;
    if (middle || this.cursorPosition().rows > old.rows) this._refreshLine();
    else this.output.write(char);
  }

  private readonly receive = (chunk: unknown) => {
    if (!(chunk instanceof Uint8Array)) throw fault('ERR_INVALID_ARG_TYPE', 'Expected input bytes');
    for (const char of this.decoder.write(Buffer.from(chunk))) {
      if (this.closed) break;
      if (
        char === '\n' &&
        this.returnedAt !== undefined &&
        Date.now() - this.returnedAt <= this.crlfDelay
      ) {
        this.returnedAt = undefined;
        continue;
      }
      this.returnedAt = undefined;
      if (this.escape) {
        this.escape += char;
        if (this.escape === '\x1b[') continue;
        const key = this.escape;
        this.escape = '';
        if (key === '\x1b[D') this.move(-1);
        else if (key === '\x1b[C') this.move(1);
        else throw fault('ENOSYS', 'Unsupported readline escape sequence');
      } else if (char === '\x03') {
        if (this.listenerCount('SIGINT')) this.emit('SIGINT');
        else {
          this.close();
          this.cancelled('Aborted with Ctrl+C');
        }
      } else if (char === '\x1b') this.escape = char;
      else if (char === '\x7f' || char === '\b') {
        if (this.cursor === 0) continue;
        this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
        this.cursor--;
        this._refreshLine();
      } else if (char === '\r' || char === '\n') {
        if (char === '\r') this.returnedAt = Date.now();
        const line = this.line;
        this.move(Number.POSITIVE_INFINITY);
        this.output.write('\r\n');
        this.line = '';
        this.cursor = this.previousRows = 0;
        this.emit('line', line);
      } else if (char >= ' ' && char <= '~') this.insert(char);
      else throw fault('ENOSYS', 'Unsupported readline control character');
    }
  };
}

export function createInterface(options: unknown) {
  return new Interface(options);
}
