// The glob pattern engine behind fs.glob, fs.globSync and fs.promises.glob.
//
// Node 22.18 delegates matching to minimatch (internal/deps/minimatch) with
// { nocase: false on Linux, windowsPathsNoEscape: true, nonegate: true,
//   nocomment: true, optimizationLevel: 2, nocaseMagicOnly: true } and consumes the
// parsed form: `set` (per brace expansion, one entry per path segment: a literal
// string, a RegExp for a segment with wildcards, or GLOBSTAR) and `globParts` (the
// matching source segments). minimatch is not a runtime dependency of this project
// and none was added, so this is an independent implementation of the subset of its
// behavior that Node's glob uses: brace expansion (lists, numeric and alphabetic
// sequences), `*`, `?`, `**`, bracket classes with POSIX names, extglobs
// (`?(`, `*(`, `+(`, `@(`, `!(`) and the path preprocessing of optimization level 2.
// Matching is case-sensitive, as on Linux. Dot files are matched only by an
// explicit leading dot. Backslash is a path separator, never an escape.
//
// Pure module: no filesystem, no globals.

/** The `**` segment. */
export const GLOBSTAR = Symbol('globstar **');

export type Segment = string | RegExp | typeof GLOBSTAR;

// ---- Brace expansion (bash rules, as brace-expansion implements them) -----------

interface Balanced {
  pre: string;
  body: string;
  post: string;
}

/** The first `{...}` pair with matching nesting; an unmatched `{` is skipped. */
function balanced(source: string): Balanced | undefined {
  for (let open = source.indexOf('{'); open >= 0; open = source.indexOf('{', open + 1)) {
    let depth = 0;
    for (let index = open; index < source.length; index++) {
      if (source[index] === '{') depth++;
      else if (source[index] === '}' && --depth === 0)
        return {
          pre: source.slice(0, open),
          body: source.slice(open + 1, index),
          post: source.slice(index + 1),
        };
    }
  }
  return undefined;
}

function commaParts(source: string): string[] {
  if (!source) return [''];
  const match = balanced(source);
  if (!match) return source.split(',');
  const parts = match.pre.split(',');
  parts[parts.length - 1] += '{' + match.body + '}';
  const rest = commaParts(match.post);
  if (match.post.length) {
    parts[parts.length - 1] += rest.shift();
    parts.push(...rest);
  }
  return parts;
}

const embrace = (text: string) => '{' + text + '}';
const numeric = (text: string) => {
  const value = Number.parseInt(text, 10);
  return Number(text) === value ? value : text.charCodeAt(0);
};
const padded = (text: string) => /^-?0\d/.test(text);

function expand(source: string, top: boolean): string[] {
  const match = balanced(source);
  if (!match || /\$$/.test(match.pre)) return [source];
  const numericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(match.body);
  const alphaSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(match.body);
  const sequence = numericSequence || alphaSequence;
  const options = match.body.includes(',');
  if (!sequence && !options) {
    // {a},b}
    if (/,(?!,).*\}/.test(match.post))
      return expand(match.pre + '{' + match.body + '\u0000' + match.post, false).map((text) =>
        text.replaceAll('\u0000', '}'),
      );
    return [source];
  }
  let parts: string[];
  if (sequence) parts = match.body.split('..');
  else {
    parts = commaParts(match.body);
    if (parts.length === 1) {
      // x{{a,b}}y ==> x{a}y x{b}y
      parts = expand(parts[0], false).map(embrace);
      if (parts.length === 1) {
        const post = match.post.length ? expand(match.post, false) : [''];
        return post.map((tail) => match.pre + parts[0] + tail);
      }
    }
  }
  const post = match.post.length ? expand(match.post, false) : [''];
  let items: string[];
  if (sequence) {
    const start = numeric(parts[0]);
    const end = numeric(parts[1]);
    const width = Math.max(parts[0].length, parts[1].length);
    let step = parts.length === 3 ? Math.abs(numeric(parts[2])) : 1;
    const reverse = end < start;
    if (reverse) step *= -1;
    const pad = parts.some(padded);
    items = [];
    for (let value = start; reverse ? value >= end : value <= end; value += step) {
      let text: string;
      if (alphaSequence) {
        text = String.fromCharCode(value);
        if (text === '\\') text = '';
      } else {
        text = String(value);
        if (pad) {
          const need = width - text.length;
          if (need > 0) {
            const zeros = '0'.repeat(need);
            text = value < 0 ? '-' + zeros + text.slice(1) : zeros + text;
          }
        }
      }
      items.push(text);
    }
  } else items = parts.flatMap((part) => expand(part, false));
  const expansions: string[] = [];
  for (const item of items)
    for (const tail of post) {
      const expansion = match.pre + item + tail;
      if (!top || sequence || expansion) expansions.push(expansion);
    }
  return expansions;
}

/** minimatch's braceExpand: a leading `{}` is kept literally, as bash does. */
export function braceExpand(pattern: string): string[] {
  if (!/\{(?:(?!\{).)*\}/.test(pattern)) return [pattern];
  if (!pattern) return [];
  if (pattern.startsWith('{}'))
    return expand('\u0001' + pattern.slice(2), true).map((text) => text.replaceAll('\u0001', '{}'));
  return expand(pattern, true);
}

// ---- One path segment -------------------------------------------------------

const escapeRegExp = (text: string) => text.replace(/[-[\]{}()*+?.,\\^$|#\s/]/g, '\\$&');

const POSIX_CLASSES: Record<string, string> = {
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

/** A bracket expression starting at `index`; undefined when it is not closed. */
function parseClass(text: string, index: number): { source: string; end: number } | undefined {
  let position = index + 1;
  let negate = false;
  if (text[position] === '!' || text[position] === '^') {
    negate = true;
    position++;
  }
  let body = '';
  let first = true;
  while (position < text.length) {
    const char = text[position];
    if (char === ']' && !first) {
      // A class that cannot match anything: nothing is a member.
      if (body === '') return { source: negate ? '[^]' : '[]', end: position + 1 };
      return { source: `[${negate ? '^' : ''}${body}]`, end: position + 1 };
    }
    first = false;
    if (char === '[' && text[position + 1] === ':') {
      const close = text.indexOf(':]', position + 2);
      const name = close > 0 ? text.slice(position + 2, close) : '';
      if (close > 0 && name in POSIX_CLASSES) {
        body += POSIX_CLASSES[name];
        position = close + 2;
        continue;
      }
    }
    if (char === '[' && (text[position + 1] === '=' || text[position + 1] === '.'))
      throw Object.assign(
        new Error(`Collating and equivalence classes are not supported in glob patterns: ${text}`),
        { code: 'ENOSYS' },
      );
    // A range a-z; a reversed range matches nothing.
    if (text[position + 1] === '-' && position + 2 < text.length && text[position + 2] !== ']') {
      const from = char;
      const to = text[position + 2];
      if (from <= to) body += `${escapeRegExp(from)}-${escapeRegExp(to)}`;
      position += 3;
      continue;
    }
    body += escapeRegExp(char);
    position++;
  }
  return undefined;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const literal = (char: string) => {
    const last = tokens[tokens.length - 1];
    if (last?.kind === 'literal') last.text += char;
    else tokens.push({ kind: 'literal', text: char });
  };
  for (let index = 0; index < text.length; ) {
    const char = text[index];
    if ('?*+@!'.includes(char) && text[index + 1] === '(') {
      // An extglob: find the matching close paren and split the body on top-level pipes.
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
        tokens.push({ kind: 'ext', type: char, alternatives: alternatives.map(tokenize) });
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
      const parsed = parseClass(text, index);
      if (parsed) {
        tokens.push({ kind: 'class', source: parsed.source });
        index = parsed.end;
      } else {
        literal(char);
        index++;
      }
    } else {
      literal(char);
      index++;
    }
  }
  return tokens;
}

/** The regular expression source of a token list; `rest` follows a negated extglob. */
function source(tokens: Token[], wholeSegment: boolean): string {
  let out = '';
  tokens.forEach((token, index) => {
    switch (token.kind) {
      case 'literal':
        out += escapeRegExp(token.text);
        break;
      case 'star':
        // A lone star matches at least one character.
        out += wholeSegment && tokens.length === 1 ? '[^/]+?' : '[^/]*?';
        break;
      case 'any':
        out += '[^/]';
        break;
      case 'class':
        out += token.source;
        break;
      case 'ext': {
        const body = token.alternatives.map((alternative) => source(alternative, false)).join('|');
        if (token.type === '!') {
          const rest = source(tokens.slice(index + 1), false);
          // Everything that does not match the body followed by the rest of the segment.
          out += `(?:(?!(?:${body})${rest}$)[^/]*?)`;
        } else if (token.type === '@') out += `(?:${body})`;
        else if (token.type === '?') out += `(?:${body})?`;
        else out += `(?:${body})${token.type}`;
        break;
      }
    }
  });
  return out;
}

/**
 * One segment: GLOBSTAR for `**`, a string when it has no wildcard (matched exactly),
 * or a RegExp. A segment whose pattern can start with a wildcard never matches a name
 * that begins with a dot.
 */
export function compileSegment(text: string): Segment {
  if (text === '**') return GLOBSTAR;
  if (text === '') return '';
  const tokens = tokenize(text);
  if (tokens.every((token) => token.kind === 'literal'))
    return tokens.map((token) => (token.kind === 'literal' ? token.text : '')).join('');
  const first = tokens[0];
  const guard = first.kind === 'literal' ? '' : '(?!\\.)';
  // A trailing negated extglob consumes the rest itself; others end at the segment.
  const expression = guard + source(tokens, true);
  // Invariant: the source is built only from escaped literals and the fixed forms above.
  return new RegExp(`^${expression}$`);
}

// ---- Whole patterns ---------------------------------------------------------

// Optimization level 2 (minimatch firstPhasePreProcess): fold repeated globstars, drop
// `.` and empty middle segments, and resolve `<segment>/..` away.
function optimize(parts: string[][]): string[][] {
  let changed: boolean;
  do {
    changed = false;
    for (const segments of parts) {
      let globstar = -1;
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
        )
          continue;
        changed = true;
        segments.splice(globstar, 1);
        const other = segments.slice(0);
        other[globstar] = '**';
        parts.push(other);
        globstar--;
      }
      for (let index = 1; index < segments.length - 1; index++) {
        const segment = segments[index];
        // A leading `//` is kept.
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
      let dots = 0;
      while ((dots = segments.indexOf('..', dots + 1)) !== -1) {
        const before = segments[dots - 1];
        if (before && before !== '.' && before !== '..' && before !== '**') {
          changed = true;
          const needDot = dots === 1 && segments[dots + 1] === '**';
          segments.splice(dots - 1, 2, ...(needDot ? ['.'] : []));
          if (segments.length === 0) segments.push('');
          dots -= 2;
        }
      }
    }
  } while (changed);
  // Identical alternatives collapse.
  const seen = new Set<string>();
  return parts.filter((segments) => {
    const key = JSON.stringify(segments);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class Matcher {
  /** The parsed segments of every brace expansion. */
  readonly set: Segment[][];
  /** The source segments of the same expansions, for cache keys. */
  readonly globParts: string[][];

  constructor(pattern: string) {
    if (typeof pattern !== 'string') throw new TypeError('invalid pattern');
    if (pattern.length > 1024 * 64) throw new TypeError('pattern is too long');
    // windowsPathsNoEscape: a backslash is a path separator on every platform.
    const text = pattern.replace(/\\/g, '/');
    // Empty patterns match nothing.
    if (!text) {
      this.set = [];
      this.globParts = [];
      return;
    }
    const split = [...new Set(braceExpand(text))].map((expansion) => expansion.split(/\/+/));
    this.globParts = optimize(split);
    this.set = this.globParts.map((segments) => segments.map(compileSegment));
  }

  /** Whether `file` (a slash-separated path) matches any expansion. */
  match(file: string): boolean {
    if (file === '/') return false;
    const names = file.split(/\/+/);
    return this.set.some((pattern) => matchOne(names, pattern));
  }
}

function matchOne(file: string[], pattern: Segment[]): boolean {
  let fileIndex = 0;
  let patternIndex = 0;
  for (; fileIndex < file.length && patternIndex < pattern.length; fileIndex++, patternIndex++) {
    const segment = pattern[patternIndex];
    const name = file[fileIndex];
    if (segment === GLOBSTAR) {
      let swallow = fileIndex;
      const next = patternIndex + 1;
      if (next === pattern.length) {
        // A trailing ** swallows everything that is not a dot file.
        for (; fileIndex < file.length; fileIndex++)
          if (
            file[fileIndex] === '.' ||
            file[fileIndex] === '..' ||
            file[fileIndex].startsWith('.')
          )
            return false;
        return true;
      }
      while (swallow < file.length) {
        const swallowed = file[swallow];
        if (matchOne(file.slice(swallow), pattern.slice(next))) return true;
        // Neither . nor .. nor a dot file can be swallowed by **.
        if (swallowed === '.' || swallowed === '..' || swallowed.startsWith('.')) break;
        swallow++;
      }
      return false;
    }
    const hit = typeof segment === 'string' ? name === segment : segment.test(name);
    if (!hit) return false;
  }
  if (fileIndex === file.length && patternIndex === pattern.length) return true;
  // The pattern ran out first: only a trailing empty name (a trailing slash) is left.
  if (patternIndex === pattern.length)
    return fileIndex === file.length - 1 && file[fileIndex] === '';
  return false;
}
