import { describe, expect, it } from 'vitest';
import { nodeOptionsRejectionMode, parseExecArgv, warningFlags } from '../../src/exec-argv';

describe('parseExecArgv', () => {
  it('defaults to an empty, inert result', () => {
    expect(parseExecArgv()).toEqual({
      argv: [],
      preloads: [],
      conditions: [],
      importMetaResolve: false,
    });
  });

  it('parses --require and --conditions with their arguments', () => {
    const result = parseExecArgv(['--require', './a.js', '--conditions', 'development']);
    expect(result.preloads).toEqual(['./a.js']);
    expect(result.conditions).toEqual(['development']);
    expect(result.argv).toEqual(['--require', './a.js', '--conditions', 'development']);
  });

  it('accumulates repeated --require and --conditions flags in order', () => {
    const result = parseExecArgv([
      '--require',
      './a.js',
      '--require',
      './b.js',
      '--conditions',
      'dev',
      '--conditions',
      'test',
    ]);
    expect(result.preloads).toEqual(['./a.js', './b.js']);
    expect(result.conditions).toEqual(['dev', 'test']);
  });

  it('sets importMetaResolve when the experimental flag is present', () => {
    expect(parseExecArgv(['--experimental-import-meta-resolve']).importMetaResolve).toBe(true);
  });

  it('rejects a non-array value', () => {
    expect(() => parseExecArgv('nope')).toThrow(/execArgv must be an array/);
  });

  it('rejects more than 256 arguments', () => {
    const many = Array.from({ length: 257 }, () => '--experimental-import-meta-resolve');
    expect(() => parseExecArgv(many)).toThrow(/Too many startup arguments/);
  });

  it('rejects a non-string argument', () => {
    expect(() => parseExecArgv([42])).toThrow(/Startup arguments must be strings without NUL/);
  });

  it('rejects an argument containing a NUL byte', () => {
    expect(() => parseExecArgv(['a\0b'])).toThrow(/Startup arguments must be strings without NUL/);
  });

  it('rejects startup arguments exceeding the aggregate byte budget', () => {
    const huge = 'a'.repeat(70 * 1024);
    expect(() => parseExecArgv([huge])).toThrow(/Startup arguments exceed limit/);
  });

  it('rejects --require without a following argument', () => {
    expect(() => parseExecArgv(['--require'])).toThrow(/Missing argument for --require/);
  });

  it('rejects --conditions without a following argument', () => {
    expect(() => parseExecArgv(['--conditions'])).toThrow(/Missing argument for --conditions/);
  });

  it('rejects unsupported flags', () => {
    expect(() => parseExecArgv(['--inspect'])).toThrow(/Unsupported startup option --inspect/);
  });

  it('parses --unhandled-rejections joined by = or as the next argument', () => {
    for (const mode of ['throw', 'strict', 'warn', 'none', 'warn-with-error-code']) {
      expect(parseExecArgv([`--unhandled-rejections=${mode}`]).unhandledRejections).toBe(mode);
      const separate = parseExecArgv(['--unhandled-rejections', mode, '--require', './a.js']);
      expect(separate.unhandledRejections).toBe(mode);
      expect(separate.preloads).toEqual(['./a.js']);
      expect(separate.argv).toEqual(['--unhandled-rejections', mode, '--require', './a.js']);
    }
    expect(parseExecArgv(['--require', './a.js']).unhandledRejections).toBeUndefined();
  });

  it('validates the last --unhandled-rejections value, as Node does', () => {
    expect(
      parseExecArgv(['--unhandled-rejections=none', '--unhandled-rejections=strict'])
        .unhandledRejections,
    ).toBe('strict');
    expect(
      parseExecArgv(['--unhandled-rejections=bogus', '--unhandled-rejections=none'])
        .unhandledRejections,
    ).toBe('none');
    for (const argv of [
      ['--unhandled-rejections=bogus'],
      ['--unhandled-rejections=Strict'],
      ['--unhandled-rejections=none', '--unhandled-rejections', 'bogus'],
    ])
      expect(() => parseExecArgv(argv)).toThrow(/invalid value for --unhandled-rejections/);
  });

  it('rejects --unhandled-rejections without a value', () => {
    expect(() => parseExecArgv(['--unhandled-rejections='])).toThrow(
      /--unhandled-rejections= requires an argument/,
    );
    for (const argv of [['--unhandled-rejections'], ['--unhandled-rejections', '--require']])
      expect(() => parseExecArgv(argv)).toThrow(/--unhandled-rejections requires an argument/);
  });

  it('keeps rejecting flags that only share the prefix', () => {
    expect(() => parseExecArgv(['--unhandled-rejections-mode=none'])).toThrow(
      /Unsupported startup option --unhandled-rejections-mode=none/,
    );
  });
});

describe('nodeOptionsRejectionMode', () => {
  it('names no mode when NODE_OPTIONS is absent, not a string or names other options', () => {
    expect(nodeOptionsRejectionMode(undefined)).toEqual({});
    expect(nodeOptionsRejectionMode(7)).toEqual({});
    expect(nodeOptionsRejectionMode('')).toEqual({});
    expect(nodeOptionsRejectionMode('--max-old-space-size=4096 --inspect')).toEqual({});
  });

  it('reads the mode joined by = or as the next token, among other options', () => {
    expect(nodeOptionsRejectionMode('--unhandled-rejections=none')).toEqual({ mode: 'none' });
    expect(nodeOptionsRejectionMode('  --inspect   --unhandled-rejections warn  ')).toEqual({
      mode: 'warn',
    });
    expect(
      nodeOptionsRejectionMode('--unhandled-rejections=bogus --unhandled-rejections=strict'),
    ).toEqual({ mode: 'strict' });
  });

  it('splits like Node: quotes group and a backslash escapes inside them', () => {
    expect(nodeOptionsRejectionMode('"--unhandled-rejections=none"')).toEqual({ mode: 'none' });
    expect(nodeOptionsRejectionMode('--unhandled-rejections "none"')).toEqual({ mode: 'none' });
    expect(nodeOptionsRejectionMode('"--unhandled-rejections=no\\ne"')).toEqual({ mode: 'none' });
    expect(nodeOptionsRejectionMode('"--unhandled-rejections=none')).toEqual({
      problem: 'invalid value for NODE_OPTIONS (unterminated string)',
    });
    expect(nodeOptionsRejectionMode('"--inspect\\')).toEqual({
      problem: 'invalid value for NODE_OPTIONS (invalid escape)',
    });
    // Outside quotes a backslash is an ordinary character.
    expect(nodeOptionsRejectionMode('--title=a\\b')).toEqual({});
  });

  it('reports what Node refuses to start with', () => {
    const invalid = { problem: 'invalid value for --unhandled-rejections' };
    expect(nodeOptionsRejectionMode('--unhandled-rejections=bogus')).toEqual(invalid);
    expect(
      nodeOptionsRejectionMode('--unhandled-rejections=none --unhandled-rejections=bogus'),
    ).toEqual(invalid);
    expect(nodeOptionsRejectionMode('--unhandled-rejections')).toEqual({
      problem: '--unhandled-rejections requires an argument',
    });
    expect(nodeOptionsRejectionMode('--unhandled-rejections --no-warnings')).toEqual({
      problem: '--unhandled-rejections requires an argument',
    });
    expect(nodeOptionsRejectionMode('--unhandled-rejections=')).toEqual({
      problem: '--unhandled-rejections= requires an argument',
    });
  });
});

describe('warningFlags', () => {
  it('accepts the warning flags at startup and reports each one', () => {
    const argv = ['--no-warnings', '--no-deprecation', '--throw-deprecation', '--trace-warnings'];
    expect(parseExecArgv([...argv, '--trace-deprecation']).argv).toEqual([
      ...argv,
      '--trace-deprecation',
    ]);
    expect(warningFlags(parseExecArgv(['--trace-deprecation']).argv)).toEqual({
      noWarnings: false,
      noDeprecation: false,
      throwDeprecation: false,
      traceWarnings: false,
      traceDeprecation: true,
    });
    expect(warningFlags([...argv, '--trace-deprecation'])).toEqual({
      noWarnings: true,
      noDeprecation: true,
      throwDeprecation: true,
      traceWarnings: true,
      traceDeprecation: true,
    });
  });

  it('does not read an argument value as a flag', () => {
    const argv = ['--require', '--no-warnings', '--conditions', '--no-deprecation'];
    expect(parseExecArgv(argv).preloads).toEqual(['--no-warnings']);
    expect(Object.values(warningFlags(argv))).toEqual([false, false, false, false, false]);
  });
});
