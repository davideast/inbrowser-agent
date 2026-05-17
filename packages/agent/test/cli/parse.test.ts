import { describe, expect, it } from 'bun:test';
import { InputHardeningError, UsageError, parseArgs } from '../../src/cli/parse.js';

describe('parseArgs — happy path', () => {
  it('parses a bare command', () => {
    const { command, options, positional } = parseArgs(['describe']);
    expect(command).toBe('describe');
    expect(options).toEqual({});
    expect(positional).toEqual([]);
  });

  it('parses --flag value pairs', () => {
    const { options } = parseArgs(['run', '--prompt', 'hello', '--max-turns', '4']);
    expect(options['prompt']).toBe('hello');
    expect(options['max-turns']).toBe(4);
  });

  it('parses --flag=value form', () => {
    const { options } = parseArgs(['run', '--max-turns=2', '--scenario=write-rules']);
    expect(options['max-turns']).toBe(2);
    expect(options['scenario']).toBe('write-rules');
  });

  it('routes -h / --help to the help command', () => {
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['-h']).command).toBe('help');
  });

  it('routes --version to the version command', () => {
    expect(parseArgs(['--version']).command).toBe('version');
  });

  it('falls back to help on empty argv', () => {
    expect(parseArgs([]).command).toBe('help');
  });

  it('accepts positional after options', () => {
    const { positional } = parseArgs(['run', '--scenario', 'echo', 'hello', 'world']);
    expect(positional).toEqual(['hello', 'world']);
  });

  it('supports -- terminator for raw positionals', () => {
    const { positional } = parseArgs(['run', '--', '--prompt', '--max-turns']);
    expect(positional).toEqual(['--prompt', '--max-turns']);
  });

  it('parses comma-separated string[] for --fields', () => {
    const { options } = parseArgs(['run', '--fields', 'ts,type,sessionId']);
    expect(options['fields']).toEqual(['ts', 'type', 'sessionId']);
  });
});

describe('parseArgs — errors', () => {
  it('rejects unknown commands', () => {
    expect(() => parseArgs(['blarg'])).toThrow(UsageError);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['run', '--zzz', 'x'])).toThrow(UsageError);
  });

  it('rejects bad enum values', () => {
    expect(() => parseArgs(['run', '--scenario', 'nope'])).toThrow(UsageError);
  });

  it('rejects non-numeric --max-turns', () => {
    expect(() => parseArgs(['run', '--max-turns', 'lots'])).toThrow(UsageError);
  });
});

describe('parseArgs — input hardening', () => {
  it('rejects control chars in --prompt', () => {
    expect(() => parseArgs(['run', '--prompt', 'hi\x01there'])).toThrow(InputHardeningError);
  });

  it('rejects path traversal in --session-id', () => {
    expect(() => parseArgs(['run', '--session-id', '../etc/passwd'])).toThrow(InputHardeningError);
  });

  it('rejects percent-encoded dots in --session-id', () => {
    expect(() => parseArgs(['run', '--session-id', '%2e%2e/x'])).toThrow(InputHardeningError);
  });

  it('rejects ? / # in --scenario', () => {
    expect(() => parseArgs(['run', '--scenario', 'echo?x=1'])).toThrow();
  });

  it('rejects oversized --prompt', () => {
    const big = 'a'.repeat(10_000);
    expect(() => parseArgs(['run', '--prompt', big])).toThrow(InputHardeningError);
  });

  it('rejects --session-id that does not match the allowlist regex', () => {
    expect(() => parseArgs(['run', '--session-id', 'has spaces'])).toThrow(InputHardeningError);
  });
});
