// Browser-safe `internal/deps/minimatch/index` bridge for `path.matchesGlob`.
// Reuses `braceExpand` and `GLOBSTAR` from `src/glob-match.ts` while implementing
// minimatch's segment compiler (single-char bracket simplification, per-alternative
// dotfile guards, `.`/`..` wildcard rejection, and POSIX bracket handling) and
// platform-aware separator/UNC/drive-letter rules matching Node.js v22.18.0.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { GLOBSTAR, type Segment, braceExpand } from '../../../glob-match';

export interface MinimatchOptions {
  nocase?: boolean;
  windowsPathsNoEscape?: boolean;
  nonegate?: boolean;
  nocomment?: boolean;
  optimizationLevel?: number;
  platform?: 'win32' | 'posix';
  nocaseMagicOnly?: boolean;
}

const DRIVE_LETTER_RE = /^[a-zA-Z]:$/;
const UNC_PREFIX_RE = /^\/\/[^/]+\/[^/]+/;

const escapeRegExp = (text: string): string => text.replace(/[-[\]{}()*+?.,\\^$|#\s/]/g, '\\$&');

const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alnum: '0-9A-Za-z',
  alpha: 'A-Za-z',
  ascii: '\\x00-\\x7f',
  blank: ' \\t',
  cntrl: '\\x00-\\x1f\\x7f',
  digit: '0-9',
  graph: '\\x21-\\x7e',
  lower: 'a-z',
  print: '\\x20-\\x7e',
  punct: '!-/:-@\\[-`{-~',
  space: ' \\t\\r\\n\\v\\f',
  upper: 'A-Z',
  word: '\\w',
  xdigit: 'A-Fa-f0-9',
};

type Token =
  | { kind: 'literal'; text: string }
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'class'; source: string }
  | { kind: 'ext'; type: string; alternatives: Token[][] };

type ParsedBracket =
  | { kind: 'literal'; text: string; end: number }
  | { kind: 'class'; source: string; end: number };

function parseBracket(text: string, index: number): ParsedBracket | undefined {
  let position = index + 1;
  let negate = false;
  if (text[position] === '!' || text[position] === '^') {
    negate = true;
    position++;
  }
  let body = '';
  let first = true;
  let itemCount = 0;
  let singleChar: string | undefined;

  while (position < text.length) {
    const char = text[position];
    if (char === ']' && !first) {
      if (body === '') {
        return { kind: 'class', source: negate ? '[^]' : '[]', end: position + 1 };
      }
      if (!negate && itemCount === 1 && singleChar !== undefined) {
        return { kind: 'literal', text: singleChar, end: position + 1 };
      }
      return { kind: 'class', source: `[${negate ? '^' : ''}${body}]`, end: position + 1 };
    }
    first = false;
    if (char === '[' && text[position + 1] === ':') {
      const close = text.indexOf(':]', position + 2);
      const name = close > 0 ? text.slice(position + 2, close) : '';
      if (close > 0 && Object.prototype.hasOwnProperty.call(POSIX_CLASSES, name)) {
        body += POSIX_CLASSES[name];
        itemCount += 2;
        singleChar = undefined;
        position = close + 2;
        continue;
      }
    }
    if (text[position + 1] === '-' && position + 2 < text.length && text[position + 2] !== ']') {
      const from = char;
      const to = text[position + 2];
      if (from <= to) {
        if (from === to) {
          body += escapeRegExp(from);
          itemCount += 1;
          singleChar = itemCount === 1 ? from : undefined;
        } else {
          body += `${escapeRegExp(from)}-${escapeRegExp(to)}`;
          itemCount += 2;
          singleChar = undefined;
        }
      }
      position += 3;
      continue;
    }
    body += escapeRegExp(char);
    itemCount += 1;
    singleChar = itemCount === 1 ? char : undefined;
    position++;
  }
  return undefined;
}

function tokenizeSegment(text: string): Token[] {
  const tokens: Token[] = [];
  const pushLiteral = (str: string) => {
    const last = tokens[tokens.length - 1];
    if (last?.kind === 'literal') last.text += str;
    else tokens.push({ kind: 'literal', text: str });
  };

  for (let index = 0; index < text.length; ) {
    const char = text[index];
    if ('?*+@!'.includes(char) && text[index + 1] === '(') {
      let depth = 0;
      let close = -1;
      for (let scan = index + 1; scan < text.length; scan++) {
        if (text[scan] === '(') depth++;
        else if (text[scan] === ')' && --depth === 0) {
          close = scan;
          break;
        }
      }
      if (close > 0) {
        const alternatives: string[] = [];
        let level = 0;
        let from = index + 2;
        for (let scan = index + 2; scan < close; scan++) {
          if (text[scan] === '(') level++;
          else if (text[scan] === ')') level--;
          else if (text[scan] === '|' && level === 0) {
            alternatives.push(text.slice(from, scan));
            from = scan + 1;
          }
        }
        alternatives.push(text.slice(from, close));
        tokens.push({ kind: 'ext', type: char, alternatives: alternatives.map(tokenizeSegment) });
        index = close + 1;
        continue;
      }
    }
    if (char === '*') {
      while (text[index + 1] === '*') index++;
      tokens.push({ kind: 'star' });
      index++;
    } else if (char === '?') {
      tokens.push({ kind: 'any' });
      index++;
    } else if (char === '[') {
      const parsed = parseBracket(text, index);
      if (parsed) {
        if (parsed.kind === 'literal') pushLiteral(parsed.text);
        else tokens.push({ kind: 'class', source: parsed.source });
        index = parsed.end;
      } else {
        pushLiteral(char);
        index++;
      }
    } else {
      pushLiteral(char);
      index++;
    }
  }
  return tokens;
}

function hasDirectWildcard(tokens: Token[]): boolean {
  return tokens.some(
    (token) =>
      token.kind === 'star' ||
      token.kind === 'any' ||
      token.kind === 'class' ||
      (token.kind === 'ext' && token.type === '!'),
  );
}

function tokensToRegExpSource(tokens: Token[], atStart: boolean, wholeSegment: boolean): string {
  let out = atStart && hasDirectWildcard(tokens) ? '(?!\\.\\.?$)' : '';
  tokens.forEach((token, index) => {
    const tokenAtStart = atStart && index === 0;
    const dotGuard = tokenAtStart ? '(?!\\.)' : '';
    switch (token.kind) {
      case 'literal':
        out += escapeRegExp(token.text);
        break;
      case 'star':
        out += dotGuard + (wholeSegment && tokens.length === 1 ? '[^/]+?' : '[^/]*?');
        break;
      case 'any':
        out += dotGuard + '[^/]';
        break;
      case 'class':
        out += dotGuard + token.source;
        break;
      case 'ext': {
        const body = token.alternatives
          .map((alt) => tokensToRegExpSource(alt, tokenAtStart, false))
          .join('|');
        if (token.type === '!') {
          const rest = tokensToRegExpSource(tokens.slice(index + 1), false, false);
          out += `${dotGuard}(?:(?!(?:${body})${rest}$)[^/]*?)`;
        } else if (token.type === '@') {
          out += `(?:${body})`;
        } else if (token.type === '?') {
          out += `(?:${body})?`;
        } else {
          out += `(?:${body})${token.type}`;
        }
        break;
      }
    }
  });
  return out;
}

function compileMinimatchSegment(text: string): Segment {
  if (text === '**') return GLOBSTAR;
  if (text === '') return '';
  const tokens = tokenizeSegment(text);
  if (tokens.every((token) => token.kind === 'literal')) {
    return tokens.map((token) => (token.kind === 'literal' ? token.text : '')).join('');
  }
  const expression = tokensToRegExpSource(tokens, true, true);
  // Invariant: `expression` is assembled solely from escaped literals and bounded glob constructs.
  return new RegExp(`^${expression}$`);
}

function slashSplit(text: string, convertBackslash: boolean, win32Unc: boolean): string[] {
  const norm = convertBackslash ? text.replaceAll('\\', '/') : text;
  if (norm === '') return [''];
  if (win32Unc && UNC_PREFIX_RE.test(norm)) {
    return ['', '', ...norm.replace(/^\/+/, '').split(/\/+/)];
  }
  return norm.split(/\/+/);
}

function optimizeParts(parts: string[][], isWin32: boolean): string[][] {
  let changed: boolean;
  do {
    changed = false;
    for (const segments of parts) {
      const uncHead =
        isWin32 && segments.length >= 4 && segments[0] === '' && segments[1] === '' ? 4 : 0;
      let globstar = Math.max(-1, uncHead - 1);
      while ((globstar = segments.indexOf('**', globstar + 1)) !== -1) {
        let last = globstar;
        while (segments[last + 1] === '**') last++;
        if (last > globstar) segments.splice(globstar + 1, last - globstar);
        const next = segments[globstar + 1];
        const first = segments[globstar + 2];
        const second = segments[globstar + 3];
        if (next !== '..') continue;
        if (
          !first ||
          first === '.' ||
          first === '..' ||
          !second ||
          second === '.' ||
          second === '..'
        ) {
          continue;
        }
        changed = true;
        segments.splice(globstar, 1);
        const other = segments.slice(0);
        other[globstar] = '**';
        parts.push(other);
        globstar--;
      }
      const startIdx = Math.max(1, uncHead);
      for (let index = startIdx; index < segments.length - 1; index++) {
        const segment = segments[index];
        if (index === 1 && segment === '' && segments[0] === '') continue;
        if (segment === '.' || segment === '') {
          changed = true;
          segments.splice(index, 1);
          index--;
        }
      }
      if (
        segments[0] === '.' &&
        segments.length === 2 &&
        (segments[1] === '.' || segments[1] === '')
      ) {
        changed = true;
        segments.pop();
      }
      let dots = Math.max(0, uncHead);
      while ((dots = segments.indexOf('..', dots + 1)) !== -1) {
        if (dots <= uncHead) continue;
        const before = segments[dots - 1];
        if (
          before &&
          before !== '.' &&
          before !== '..' &&
          before !== '**' &&
          !(isWin32 && dots === 1 && DRIVE_LETTER_RE.test(before))
        ) {
          changed = true;
          const needDot = dots === 1 && segments[dots + 1] === '**';
          segments.splice(dots - 1, 2, ...(needDot ? ['.'] : []));
          if (segments.length === 0) segments.push('');
          dots -= 2;
        }
      }
    }
  } while (changed);

  const seen = new Set<string>();
  return parts.filter((segments) => {
    const key = JSON.stringify(segments);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchOne(file: string[], pattern: Segment[], isWin32: boolean, atRoot: boolean): boolean {
  let fileIndex = 0;
  let patternIndex = 0;
  for (; fileIndex < file.length && patternIndex < pattern.length; fileIndex++, patternIndex++) {
    const segment = pattern[patternIndex];
    const name = file[fileIndex];
    if (segment === GLOBSTAR) {
      let swallow = fileIndex;
      const next = patternIndex + 1;
      if (next === pattern.length) {
        for (; fileIndex < file.length; fileIndex++) {
          const item = file[fileIndex];
          if (item === '.' || item === '..' || item.startsWith('.')) return false;
        }
        return true;
      }
      while (swallow < file.length) {
        const swallowed = file[swallow];
        if (matchOne(file.slice(swallow), pattern.slice(next), isWin32, false)) return true;
        if (swallowed === '.' || swallowed === '..' || swallowed.startsWith('.')) break;
        swallow++;
      }
      return false;
    }
    let hit: boolean;
    if (typeof segment === 'string') {
      if (
        atRoot &&
        fileIndex === 0 &&
        patternIndex === 0 &&
        isWin32 &&
        DRIVE_LETTER_RE.test(segment) &&
        DRIVE_LETTER_RE.test(name)
      ) {
        hit = segment.toLowerCase() === name.toLowerCase();
      } else {
        hit = name === segment;
      }
    } else {
      hit = segment.test(name);
    }
    if (!hit) return false;
  }
  if (fileIndex === file.length && patternIndex === pattern.length) return true;
  if (patternIndex === pattern.length) {
    return fileIndex === file.length - 1 && file[fileIndex] === '';
  }
  return false;
}

export function minimatch(file: string, pattern: string, options?: MinimatchOptions): boolean {
  if (typeof pattern !== 'string') throw new TypeError('invalid pattern');
  if (pattern.length > 1024 * 64) throw new TypeError('pattern is too long');
  if (pattern === '') return file === '';
  if (file === '') return false;

  const isWin32 = options?.platform === 'win32';
  const windowsPathsNoEscape = options?.windowsPathsNoEscape !== false;
  const patternText = windowsPathsNoEscape ? pattern.replaceAll('\\', '/') : pattern;
  if (patternText === '') return false;

  const rawExpansions = [...new Set(braceExpand(patternText))].map((expansion) =>
    slashSplit(expansion, false, isWin32),
  );
  const compiledSets = optimizeParts(rawExpansions, isWin32).map((segments) =>
    segments.map(compileMinimatchSegment),
  );

  const fileSegments = optimizeParts([slashSplit(file, isWin32, isWin32)], isWin32)[0] ?? [''];
  return compiledSets.some((set) => matchOne(fileSegments, set, isWin32, true));
}

export default { minimatch };
