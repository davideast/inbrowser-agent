import { describe, expect, it } from 'vitest';
import { styleCodes } from '../../src/style-codes';

describe('styleCodes', () => {
  it('gives every style a two-element [open, close] SGR pair of integers', () => {
    for (const [name, pair] of Object.entries(styleCodes)) {
      expect(pair, name).toHaveLength(2);
      expect(Number.isInteger(pair[0]), `${name} open`).toBe(true);
      expect(Number.isInteger(pair[1]), `${name} close`).toBe(true);
      expect(pair[0]).toBeGreaterThanOrEqual(0);
      expect(pair[1]).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps documented aliases identical to their canonical style', () => {
    expect(styleCodes.grey).toEqual(styleCodes.gray);
    expect(styleCodes.blackBright).toEqual(styleCodes.gray);
    expect(styleCodes.bgGrey).toEqual(styleCodes.bgGray);
    expect(styleCodes.bgBlackBright).toEqual(styleCodes.bgGray);
    expect(styleCodes.faint).toEqual(styleCodes.dim);
    expect(styleCodes.crossedout).toEqual(styleCodes.strikethrough);
    expect(styleCodes.crossedOut).toEqual(styleCodes.strikethrough);
    expect(styleCodes.conceal).toEqual(styleCodes.hidden);
    expect(styleCodes.swapColors).toEqual(styleCodes.inverse);
    expect(styleCodes.swapcolors).toEqual(styleCodes.inverse);
    expect(styleCodes.doubleUnderline).toEqual(styleCodes.doubleunderline);
  });

  it('resets bold with 22, matching Node (not the naive complement 21)', () => {
    expect(styleCodes.bold).toEqual([1, 22]);
  });

  it('pairs foreground colors with the default-foreground reset code 39', () => {
    for (const name of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']) {
      expect(styleCodes[name][1]).toBe(39);
    }
  });

  it('pairs background colors with the default-background reset code 49', () => {
    for (const name of [
      'bgBlack',
      'bgRed',
      'bgGreen',
      'bgYellow',
      'bgBlue',
      'bgMagenta',
      'bgCyan',
      'bgWhite',
    ]) {
      expect(styleCodes[name][1]).toBe(49);
    }
  });
});
