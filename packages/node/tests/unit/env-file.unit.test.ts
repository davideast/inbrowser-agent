import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/env-file';

// Each expectation is the pinned Node 22.18.0 binary's process.loadEnvFile result
// for the same text (recorded in docs/evidence/tdd-log.md, "process.loadEnvFile").
const parsed = (text: string) => Object.fromEntries(parseEnv(text));

describe('parseEnv', () => {
  it('keeps a comment-looking key indented after a quoted value, as Node does', () => {
    expect(parsed('A="quoted"\n  # C1=commented\nB=after')).toEqual({
      A: 'quoted',
      '# C1': 'commented',
      B: 'after',
    });
    expect(parsed('A=plain\n  # C2=commented\nB=after')).toEqual({ A: 'plain', B: 'after' });
  });

  it('spans lines inside quotes and expands \\n only in double quotes', () => {
    expect(parsed('A="spans\nB=lines"\nC=c')).toEqual({ A: 'spans\nB=lines', C: 'c' });
    expect(parsed('A= "lead space quoted"\nB=`multi\nline`\nC="esc \\\\n \\n"')).toEqual({
      A: 'lead space quoted',
      B: 'multi\nline',
      C: 'esc \\\n \n',
    });
  });

  it('reads export prefixes, tabs, inline comments and repeated equals signs', () => {
    expect(parsed('export=val\nexport X=1\nTAB\t=\ttabbed\t\nK=v # c\n#=\n')).toEqual({
      export: 'val',
      X: '1',
      TAB: 'tabbed',
      K: 'v',
    });
    expect(parsed('A=a=b=c\nB==\nC=\'\'\nD=""\nE=``')).toEqual({
      A: 'a=b=c',
      B: '=',
      C: '',
      D: '',
      E: '',
    });
  });

  it('takes the next line as the value of a key whose value is only spaces', () => {
    expect(parsed("EMPTY_SPACES=   \nSINGLE_QUOTES='single_quotes'\nLAST=last")).toEqual({
      EMPTY_SPACES: "SINGLE_QUOTES='single_quotes'",
      LAST: 'last',
    });
  });

  it('skips blank lines, lines without =, empty keys and unclosed quotes stay literal', () => {
    expect(parsed('A=1\n\n\n   \n\nB=2')).toEqual({ A: '1', B: '2' });
    expect(parsed('ONLY_KEY')).toEqual({});
    expect(
      parsed('UNTERMINATED="no close\nNO_EQUALS\n=novalue\nCRLF=crlf\r\nX=first\nX=second'),
    ).toEqual({
      UNTERMINATED: '"no close',
      CRLF: 'crlf',
      X: 'second',
    });
  });
});
