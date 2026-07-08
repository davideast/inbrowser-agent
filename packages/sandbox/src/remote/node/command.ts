import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { HostCommandResult, HostCommandRunOptions, HostCommandRunner } from '../host/types.js';

const DEFAULT_MAX_BUFFERED_OUTPUT_CHARS = 1_048_576;

export function createNodeCommandRunner(): HostCommandRunner {
  return {
    async run(args, options = {}) {
      if (args.length === 0) throw new Error('Host command runner requires at least one arg');
      const command = args[0];
      if (!command) throw new Error('Host command runner requires a command');
      const proc = spawn(command, Array.from(args.slice(1)), {
        signal: options.signal,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        readNodeStream(proc.stdout, 'stdout', options),
        readNodeStream(proc.stderr, 'stderr', options),
        new Promise<number>((resolve, reject) => {
          proc.on('error', reject);
          proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
            resolve(code ?? (signal ? 1 : 0));
          });
        }),
      ]);
      if (options.rejectOnFailure && exitCode !== 0) {
        throw new Error(`${args.join(' ')} failed (${exitCode}): ${stderr.text || stdout.text}`);
      }
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      } satisfies HostCommandResult;
    },
  };
}

function readNodeStream(
  stream: Readable | null,
  name: 'stdout' | 'stderr',
  options: HostCommandRunOptions,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return Promise.resolve({ text: '', truncated: false });
  const maxBufferedOutputChars =
    options.maxBufferedOutputChars ?? DEFAULT_MAX_BUFFERED_OUTPUT_CHARS;
  let text = '';
  let truncated = false;
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => {
      const chunkText = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      ({ text, truncated } = appendOutput(text, truncated, chunkText, maxBufferedOutputChars));
      if (chunkText) options.onOutput?.({ stream: name, chunk: chunkText });
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ text, truncated }));
  });
}

function appendOutput(
  text: string,
  truncated: boolean,
  chunkText: string,
  maxBufferedOutputChars: number,
): { text: string; truncated: boolean } {
  if (text.length < maxBufferedOutputChars) {
    const nextText = text + chunkText.slice(0, maxBufferedOutputChars - text.length);
    return {
      text: nextText,
      truncated: truncated || nextText.length >= maxBufferedOutputChars,
    };
  }
  return { text, truncated: true };
}
