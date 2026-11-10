import path from 'path-browserify';
import type { createFs } from './fs';
import { fault, record } from './protocol';
import { resourceLimits } from './resource-policy';
import { isWasmBinary } from './wasi';

export class ShellError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Redirect = { fd: 0 | 1 | 2; flags: 'r' | 'w' | 'a' };
type ShellWord = {
  value: string;
  assignment: boolean;
  operator?: '&&' | '||' | '|';
  redirect?: Redirect;
};
export type ShellCommand = {
  words: ShellWord[];
  when: 'always' | 'success' | 'failure' | 'pipe';
  redirects: Array<Redirect & { filename: string }>;
};

function words(script: string): ShellWord[] {
  if (new TextEncoder().encode(script).byteLength > resourceLimits().child.shellScriptBytes)
    throw new ShellError(2, 'E2BIG', 'Shell script exceeds 64 KiB');
  const result: ShellWord[] = [];
  let word = '';
  let started = false;
  let quote = '';
  let assignment = false;
  let unquotedName = true;
  const push = () => {
    if (!started) return;
    if (result.length >= resourceLimits().child.shellWords)
      throw new ShellError(2, 'E2BIG', 'Too many shell arguments');
    result.push({ value: word, assignment });
    word = '';
    started = false;
    assignment = false;
    unquotedName = true;
  };
  for (let i = 0; i < script.length; i++) {
    const char = script[i];
    if (char === undefined) break;
    if (quote === "'") {
      if (char === "'") quote = '';
      else word += char;
      continue;
    }
    if (char === '\\') {
      const next = script[++i];
      if (next === undefined) throw new ShellError(2, 'EINVAL', 'Trailing shell escape');
      if (next === '\n') continue;
      if (!assignment) unquotedName = false;
      word += quote === '"' && !'"$`\\'.includes(next) ? '\\' + next : next;
      started = true;
      continue;
    }
    if (char === '$' || char === '`')
      throw new ShellError(2, 'ENOSYS', 'Shell expansion is unsupported');
    if (quote === '"') {
      if (char === '"') quote = '';
      else word += char;
      continue;
    }
    if (char === ' ' || char === '\t') {
      push();
      continue;
    }
    if (char === "'" || char === '"') {
      if (!assignment) unquotedName = false;
      quote = char;
      started = true;
      continue;
    }
    if ((char === '&' || char === '|') && script[i + 1] === char) {
      push();
      if (result.length >= resourceLimits().child.shellWords)
        throw new ShellError(2, 'E2BIG', 'Too many shell arguments');
      const operator = char === '&' ? '&&' : '||';
      result.push({ value: operator, assignment: false, operator });
      i++;
      continue;
    }
    if (char === '|') {
      push();
      if (result.length >= resourceLimits().child.shellWords)
        throw new ShellError(2, 'E2BIG', 'Too many shell arguments');
      result.push({ value: '|', assignment: false, operator: '|' });
      continue;
    }
    if (char === '<' || char === '>') {
      let fd = char === '<' ? 0 : 1;
      if (started && unquotedName && /^\d+$/.test(word)) {
        fd = Number(word);
        word = '';
        started = false;
      }
      if ((char === '<' && fd !== 0) || (char === '>' && fd !== 1 && fd !== 2))
        throw new ShellError(
          2,
          'ENOSYS',
          'Only stdin, stdout and stderr file redirection is supported',
        );
      if (char === '<' && (script[i + 1] === '<' || script[i + 1] === '>'))
        throw new ShellError(
          2,
          'ENOSYS',
          'Here documents and read/write redirection are unsupported',
        );
      push();
      const flags = char === '<' ? 'r' : script[i + 1] === '>' ? 'a' : 'w';
      if (flags === 'a') i++;
      if (result.length >= resourceLimits().child.shellWords)
        throw new ShellError(2, 'E2BIG', 'Too many shell arguments');
      // The direction checks above restrict the descriptor to 0, 1 or 2.
      result.push({ value: char, assignment: false, redirect: { fd: fd as 0 | 1 | 2, flags } });
      continue;
    }
    if ('\n;&|<>()*?[]~'.includes(char) || (char === '#' && !started))
      throw new ShellError(2, 'ENOSYS', 'Shell operators, comments and expansions are unsupported');
    if (char === '=' && unquotedName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) assignment = true;
    word += char;
    started = true;
  }
  if (quote) throw new ShellError(2, 'EINVAL', 'Unterminated shell quote');
  push();
  return result;
}

export function parseShell(args: unknown[]): ShellCommand[] {
  if (args.length !== 2 || args[0] !== '-c' || typeof args[1] !== 'string')
    throw new ShellError(2, 'ENOSYS', 'Only sh -c with one command string is supported');
  const program: ShellCommand[] = [];
  let command: ShellCommand = { words: [], when: 'always', redirects: [] };
  const finish = () => {
    if (command.words.length === 0) throw new ShellError(2, 'EINVAL', 'Missing shell command');
    if (command.words.every((word) => word.assignment))
      throw new ShellError(2, 'ENOSYS', 'Assignment-only shell statements are unsupported');
    program.push(command);
  };
  // Parse the entire script before any command can have side effects.
  const tokens = words(args[1]);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) break;
    if (token.redirect) {
      const filename = tokens[++index];
      if (!filename || filename.operator || filename.redirect)
        throw new ShellError(2, 'EINVAL', 'Missing redirection filename');
      command.redirects.push({ ...token.redirect, filename: filename.value });
    } else if (token.operator) {
      finish();
      command = {
        words: [],
        redirects: [],
        when: token.operator === '&&' ? 'success' : token.operator === '||' ? 'failure' : 'pipe',
      };
    } else command.words.push(token);
  }
  finish();
  return program;
}

export function shellEntry(
  parsed: ShellCommand,
  cwd: string,
  env: Record<string, unknown>,
  fs: ReturnType<typeof createFs>,
): string[] {
  const tokens = [...parsed.words];
  while (tokens[0]?.assignment) {
    const token = tokens.shift();
    if (!token) break;
    const equals = token.value.indexOf('=');
    // The environment belongs to this process. Define own properties so names
    // such as __proto__ remain ordinary environment variables.
    Object.defineProperty(env, token.value.slice(0, equals), {
      value: token.value.slice(equals + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const command = tokens.map((token) => token.value);
  const executable = command.shift();
  if (!executable) throw new ShellError(2, 'ENOSYS', 'Empty shell commands are unsupported');
  const search = typeof env.PATH === 'string' ? env.PATH : '/bin';
  const find = (name: string): { filename: string; virtual: boolean } => {
    const candidates = name.includes('/')
      ? [path.resolve(cwd, name)]
      : search.split(':').map((directory) => path.resolve(cwd, directory || '.', name));
    let denied = false;
    for (const filename of candidates) {
      if (!fs.statSync) throw fault('EPROTO', 'Missing filesystem stat');
      try {
        const stat = fs.statSync(filename);
        if (!record(stat) || typeof stat.isFile !== 'function')
          throw fault('EPROTO', 'Invalid file stat');
        if (stat.isFile()) {
          // POSIX shells run a file only when the owner execute bit is set: PATH
          // search skips a candidate without it, and if none qualifies the command
          // fails with 126 (permission denied) instead of 127 (not found).
          if (!fs.accessSync) throw fault('EPROTO', 'Missing filesystem access');
          try {
            fs.accessSync(filename, 1);
            return { filename, virtual: false };
          } catch (error) {
            if (!record(error) || error.code !== 'EACCES') throw error;
            if (isWasmBinary(fs, filename)) return { filename, virtual: false };
            denied = true;
            continue;
          }
        }
      } catch (error) {
        if (!record(error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
      }
      if (filename === '/bin/node') return { filename, virtual: true };
    }
    if (denied) throw new ShellError(126, 'EACCES', `Permission denied: ${name}`);
    throw new ShellError(127, 'ENOENT', `Command not found: ${name}`);
  };
  const target = find(executable);
  if (target.virtual) {
    if (!command[0] || command[0].startsWith('-'))
      throw new ShellError(2, 'ENOSYS', 'Node shell commands require an entry file');
    return command;
  }
  if (isWasmBinary(fs, target.filename)) return [target.filename, ...command];
  if (!fs.readFileSync) throw fault('EPROTO', 'Missing filesystem read');
  const source = fs.readFileSync(target.filename, 'utf8');
  if (typeof source !== 'string') throw fault('EPROTO', 'Invalid executable source');
  const header = source.split('\n', 1)[0]?.trim();
  const interpreter =
    header === '#!/usr/bin/env node' ? 'node' : header === '#!/bin/node' ? '/bin/node' : undefined;
  if (!interpreter || !find(interpreter).virtual)
    throw new ShellError(126, 'ENOSYS', `Unsupported executable interpreter: ${target.filename}`);
  return [target.filename, ...command];
}
