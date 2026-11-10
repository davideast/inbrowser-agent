import { describe, expect, it } from 'vitest';
import { createScriptMaps, decodeMappings, formatStack } from '../../src/context-stack';

const inline = (mappings: string) =>
  'compiled();\n//# sourceMappingURL=data:application/json;base64,' +
  btoa(JSON.stringify({ version: 3, sources: ['a.js'], mappings })) +
  '\n//# sourceURL=guest:/a.js';

describe('decodeMappings', () => {
  it('accumulates deltas per line and resets only the generated column', () => {
    // Line 0: column 0 -> 0:0, column 4 -> 0:4. Line 1: nothing. Line 2:
    // column 0 -> 1:4, then a one-field segment that names no source.
    expect(decodeMappings('AAAA,IAAI;;AACA,C')).toEqual([[0, 0, 0, 4, 0, 4], [], [0, 1, 4]]);
  });

  it('decodes negative and multi-digit values', () => {
    // 'D' is -1; 'gB' is 16 (continuation digit then 1).
    expect(decodeMappings('AAgBA;AADD')).toEqual([
      [0, 16, 0],
      [0, 15, -1],
    ]);
  });

  it('rejects text that is not base64 VLQ', () => {
    expect(() => decodeMappings('A*')).toThrow('Invalid source map');
  });
});

describe('createScriptMaps', () => {
  it('maps a reported position through the wrapper offset to the original position', () => {
    const scripts = createScriptMaps(1 << 20);
    scripts.register('guest:/a.js', inline('AAAA,IAAI;;AACA'), {
      lineOffset: 2,
      firstLineShift: 0,
    });
    // Reported line 3 is generated line 0 behind a two-line wrapper.
    expect(scripts.locate('guest:/a.js', 3, 1)).toEqual({ line: 1, column: 1 });
    expect(scripts.locate('guest:/a.js', 3, 4)).toEqual({ line: 1, column: 1 });
    expect(scripts.locate('guest:/a.js', 3, 9)).toEqual({ line: 1, column: 5 });
    expect(scripts.locate('guest:/a.js', 5, 30)).toEqual({ line: 2, column: 5 });
  });

  it('reports generated code where the compiler mapped nothing', () => {
    const scripts = createScriptMaps(1 << 20);
    scripts.register('guest:/a.js', inline(';;IAAA'), { lineOffset: 0, firstLineShift: 0 });
    expect(scripts.locate('guest:/a.js', 1, 1)).toBe('generated');
    expect(scripts.locate('guest:/a.js', 3, 2)).toBe('generated');
    expect(scripts.locate('guest:/a.js', 3, 5)).toEqual({ line: 1, column: 1 });
    expect(scripts.locate('guest:/a.js', 99, 1)).toBe('generated');
  });

  it('treats a script without a map as its own source behind the wrapper', () => {
    const scripts = createScriptMaps(1 << 20);
    scripts.register('guest:/plain.js', 'plain();', { lineOffset: 2, firstLineShift: 0 });
    expect(scripts.locate('guest:/plain.js', 9, 7)).toEqual({ line: 7, column: 7 });
  });

  it('removes the loader prologue from first-line columns only', () => {
    const scripts = createScriptMaps(1 << 20);
    scripts.register('http://x/m.mjs', 'prologue();first();\nsecond();', {
      lineOffset: 0,
      firstLineShift: 11,
    });
    expect(scripts.locate('http://x/m.mjs', 1, 12)).toEqual({ line: 1, column: 1 });
    expect(scripts.locate('http://x/m.mjs', 1, 3)).toEqual({ line: 1, column: 1 });
    expect(scripts.locate('http://x/m.mjs', 2, 12)).toEqual({ line: 2, column: 12 });
  });

  it('removes text inserted after compilation from columns before mapping them', () => {
    const scripts = createScriptMaps(1 << 20);
    // Generated line 0 maps column 0 -> 0:0, column 4 -> 0:4, column 10 -> 0:20.
    // The runtime inserted 3 characters before column 4 and 5 before column 10.
    scripts.register('guest:/a.js', inline('AAAA,IAAI,MAAgB'), {
      lineOffset: 1,
      firstLineShift: 0,
      insertions: new Map([[0, [4, 3, 10, 5]]]),
    });
    // Before the first insertion nothing moves.
    expect(scripts.locate('guest:/a.js', 2, 4)).toEqual({ line: 1, column: 1 });
    // Inside inserted text: the position it was inserted at.
    expect(scripts.locate('guest:/a.js', 2, 5)).toEqual({ line: 1, column: 5 });
    expect(scripts.locate('guest:/a.js', 2, 7)).toEqual({ line: 1, column: 5 });
    // After it: three columns earlier.
    expect(scripts.locate('guest:/a.js', 2, 8)).toEqual({ line: 1, column: 5 });
    expect(scripts.locate('guest:/a.js', 2, 13)).toEqual({ line: 1, column: 5 });
    // After both insertions: eight columns earlier.
    expect(scripts.locate('guest:/a.js', 2, 19)).toEqual({ line: 1, column: 21 });
    // Without a map the same columns are removed.
    scripts.register('guest:/plain.js', 'plain();', {
      lineOffset: 0,
      firstLineShift: 0,
      insertions: new Map([[1, [0, 4]]]),
    });
    expect(scripts.locate('guest:/plain.js', 2, 9)).toEqual({ line: 2, column: 5 });
    expect(scripts.locate('guest:/plain.js', 1, 9)).toEqual({ line: 1, column: 9 });
  });

  it('does not register a script that would exceed the bound and leaves it unmapped', () => {
    const compiled = inline('AAAA');
    const scripts = createScriptMaps('guest:/a.js'.length + 10);
    scripts.register('guest:/a.js', compiled, { lineOffset: 0, firstLineShift: 0 });
    expect(scripts.locate('guest:/a.js', 1, 1)).toBeUndefined();
    // A script without a map costs only its name and still fits.
    scripts.register('guest:/b.js', 'plain();', { lineOffset: 0, firstLineShift: 0 });
    expect(scripts.locate('guest:/b.js', 4, 2)).toEqual({ line: 4, column: 2 });
    // The bound is on what is retained: re-registering a name replaces its cost.
    scripts.register('guest:/b.js', 'changed();', { lineOffset: 1, firstLineShift: 0 });
    expect(scripts.locate('guest:/b.js', 4, 2)).toEqual({ line: 3, column: 2 });
    expect(scripts.locate('guest:/unknown.js', 1, 1)).toBeUndefined();
  });
});

describe('formatStack', () => {
  const site = (
    text: string,
    name: string | undefined,
    line: number | null,
    column: number | null,
  ) => ({
    toString: () => text,
    getScriptNameOrSourceURL: () => name,
    getLineNumber: () => line,
    getColumnNumber: () => column,
  });
  const locate = (name: string, line: number) =>
    name === 'guest:/a.js'
      ? line === 7
        ? ('generated' as const)
        : { line: line - 20, column: 9 }
      : undefined;

  it('rewrites registered frames, drops compiler frames and keeps every other frame', () => {
    const error = new TypeError('failed');
    expect(
      formatStack(
        error,
        [
          site('eval (guest:/a.js:27:11)', 'guest:/a.js', 27, 11),
          site('Generator.next (<anonymous>)', undefined, null, null),
          site('fulfilled (guest:/a.js:7:24)', 'guest:/a.js', 7, 24),
          site('other (guest:/b.js:3:1)', 'guest:/b.js', 3, 1),
          site('guest:/a.js:30:5', 'guest:/a.js', 30, 5),
        ],
        locate,
      ),
    ).toBe(
      [
        'TypeError: failed',
        '    at eval (guest:/a.js:7:9)',
        '    at Generator.next (<anonymous>)',
        '    at other (guest:/b.js:3:1)',
        '    at guest:/a.js:10:9',
      ].join('\n'),
    );
  });

  it('formats the header as the engine does for objects that are not errors', () => {
    expect(formatStack({}, [], locate)).toBe('Error');
    expect(formatStack({ name: 'Custom', message: 'text' }, [], locate)).toBe('Custom: text');
    const hostile = {
      get name(): string {
        throw new Error('no name');
      },
    };
    expect(formatStack(hostile, [], locate)).toBe('<error>');
  });
});
