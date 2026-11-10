import { Buffer } from 'buffer';
import { parse as acornParse } from 'acorn';
import { invalidArgType, invalidArgValue } from './node-errors';

export interface StripTypeScriptTypesOptions {
  mode?: 'strip' | 'transform';
  sourceMap?: boolean;
  sourceUrl?: string;
}

type TokenKind =
  | 'ident'
  | 'number'
  | 'string'
  | 'regex'
  | 'punct'
  | 'template_no_sub'
  | 'template_head'
  | 'template_middle'
  | 'template_tail';

interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
  lineBefore: boolean;
}

function unsupportedSyntaxError(message: string): SyntaxError {
  return Object.assign(new SyntaxError(message), {
    code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
  });
}

function invalidSyntaxError(message: string): SyntaxError {
  return Object.assign(new SyntaxError(message), {
    code: 'ERR_INVALID_TYPESCRIPT_SYNTAX',
  });
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'delete',
  'void',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'do',
  'else',
  'yield',
  'await',
]);

const ACCESS_MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'override']);

const IDENT_START_RE = /[\p{ID_Start}$_]/u;
const IDENT_CONT_RE = /[\p{ID_Continue}$\u200C\u200D]/u;

function isIdentStart(ch: string): boolean {
  return ch.length > 0 && IDENT_START_RE.test(ch);
}

function isIdentContinue(ch: string): boolean {
  return ch.length > 0 && IDENT_CONT_RE.test(ch);
}

function canPrecedeRegex(prev: Token | undefined): boolean {
  if (!prev) return true;
  if (prev.kind === 'ident') {
    return REGEX_PRECEDING_KEYWORDS.has(prev.value);
  }
  if (
    prev.kind === 'number' ||
    prev.kind === 'string' ||
    prev.kind === 'regex' ||
    prev.kind === 'template_no_sub' ||
    prev.kind === 'template_tail'
  ) {
    return false;
  }
  if (prev.kind === 'punct') {
    return prev.value !== ')' && prev.value !== ']' && prev.value !== '++' && prev.value !== '--';
  }
  return true;
}

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  const len = code.length;
  let pos = 0;
  let lineBefore = true;
  const templateBraceStack: number[] = [];

  if (code.startsWith('#!')) {
    while (pos < len && code[pos] !== '\n' && code[pos] !== '\r') {
      pos += 1;
    }
  }

  const scanTemplateChunk = (startPos: number, isHead: boolean): void => {
    let i = startPos + 1;
    while (i < len) {
      const ch = code[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        i += 1;
        tokens.push({
          kind: isHead ? 'template_no_sub' : 'template_tail',
          value: code.slice(startPos, i),
          start: startPos,
          end: i,
          lineBefore,
        });
        lineBefore = false;
        pos = i;
        return;
      }
      if (ch === '$' && code[i + 1] === '{') {
        i += 2;
        tokens.push({
          kind: isHead ? 'template_head' : 'template_middle',
          value: code.slice(startPos, i),
          start: startPos,
          end: i,
          lineBefore,
        });
        lineBefore = false;
        templateBraceStack.push(0);
        pos = i;
        return;
      }
      i += 1;
    }
    throw invalidSyntaxError('Unterminated template literal');
  };

  while (pos < len) {
    const ch = code[pos];

    if (ch === ' ' || ch === '\t' || ch === '\v' || ch === '\f' || ch === '\uFEFF') {
      pos += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      lineBefore = true;
      pos += 1;
      continue;
    }

    if (ch === '/' && code[pos + 1] === '/') {
      pos += 2;
      while (pos < len && code[pos] !== '\n' && code[pos] !== '\r') {
        pos += 1;
      }
      continue;
    }
    if (ch === '/' && code[pos + 1] === '*') {
      pos += 2;
      let closed = false;
      while (pos < len) {
        if (code[pos] === '\n' || code[pos] === '\r') {
          lineBefore = true;
        }
        if (code[pos] === '*' && code[pos + 1] === '/') {
          pos += 2;
          closed = true;
          break;
        }
        pos += 1;
      }
      if (!closed) {
        throw invalidSyntaxError('Unterminated block comment');
      }
      continue;
    }

    if (ch === '`') {
      scanTemplateChunk(pos, true);
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = pos;
      pos += 1;
      let closed = false;
      while (pos < len) {
        const c = code[pos];
        if (c === '\\') {
          pos += 2;
          continue;
        }
        if (c === '\n' || c === '\r') {
          throw invalidSyntaxError('Unterminated string literal');
        }
        if (c === quote) {
          pos += 1;
          closed = true;
          break;
        }
        pos += 1;
      }
      if (!closed) {
        throw invalidSyntaxError('Unterminated string literal');
      }
      tokens.push({
        kind: 'string',
        value: code.slice(start, pos),
        start,
        end: pos,
        lineBefore,
      });
      lineBefore = false;
      continue;
    }

    if (
      (ch >= '0' && ch <= '9') ||
      (ch === '.' && pos + 1 < len && code[pos + 1] >= '0' && code[pos + 1] <= '9')
    ) {
      const start = pos;
      pos += 1;
      while (pos < len && /[0-9a-fA-FoObBxX_n.]/.test(code[pos])) {
        if ((code[pos] === 'e' || code[pos] === 'E') && /[+-]/.test(code[pos + 1] ?? '')) {
          pos += 2;
          continue;
        }
        pos += 1;
      }
      tokens.push({
        kind: 'number',
        value: code.slice(start, pos),
        start,
        end: pos,
        lineBefore,
      });
      lineBefore = false;
      continue;
    }

    const cp = code.codePointAt(pos);
    const fullChar = cp !== undefined ? String.fromCodePoint(cp) : ch;
    if (
      isIdentStart(fullChar) ||
      (ch === '#' &&
        pos + 1 < len &&
        isIdentStart(String.fromCodePoint(code.codePointAt(pos + 1) ?? 0)))
    ) {
      const start = pos;
      pos += fullChar.length;
      while (pos < len) {
        const nextCp = code.codePointAt(pos);
        if (nextCp === undefined) break;
        const nextCh = String.fromCodePoint(nextCp);
        if (!isIdentContinue(nextCh)) break;
        pos += nextCh.length;
      }
      tokens.push({
        kind: 'ident',
        value: code.slice(start, pos),
        start,
        end: pos,
        lineBefore,
      });
      lineBefore = false;
      continue;
    }

    if (ch === '/' && canPrecedeRegex(tokens[tokens.length - 1])) {
      const start = pos;
      let i = pos + 1;
      let inClass = false;
      let validRegex = false;
      while (i < len) {
        const c = code[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '\n' || c === '\r') {
          break;
        }
        if (c === '[') {
          inClass = true;
        } else if (c === ']') {
          inClass = false;
        } else if (c === '/' && !inClass) {
          i += 1;
          while (i < len && /[a-zA-Z]/.test(code[i])) {
            i += 1;
          }
          validRegex = true;
          break;
        }
        i += 1;
      }
      if (validRegex) {
        tokens.push({
          kind: 'regex',
          value: code.slice(start, i),
          start,
          end: i,
          lineBefore,
        });
        lineBefore = false;
        pos = i;
        continue;
      }
    }

    if (ch === '{' && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1] += 1;
      tokens.push({ kind: 'punct', value: '{', start: pos, end: pos + 1, lineBefore });
      lineBefore = false;
      pos += 1;
      continue;
    }
    if (ch === '}' && templateBraceStack.length > 0) {
      const top = templateBraceStack[templateBraceStack.length - 1];
      if (top === 0) {
        templateBraceStack.pop();
        scanTemplateChunk(pos, false);
        continue;
      }
      templateBraceStack[templateBraceStack.length - 1] -= 1;
      tokens.push({ kind: 'punct', value: '}', start: pos, end: pos + 1, lineBefore });
      lineBefore = false;
      pos += 1;
      continue;
    }

    const three = code.slice(pos, pos + 3);
    if (
      three === '...' ||
      three === '===' ||
      three === '!==' ||
      three === '??=' ||
      three === '&&=' ||
      three === '||=' ||
      three === '**='
    ) {
      tokens.push({ kind: 'punct', value: three, start: pos, end: pos + 3, lineBefore });
      lineBefore = false;
      pos += 3;
      continue;
    }
    const two = code.slice(pos, pos + 2);
    if (
      two === '=>' ||
      two === '==' ||
      two === '!=' ||
      two === '&&' ||
      two === '||' ||
      two === '??' ||
      two === '?.' ||
      two === '++' ||
      two === '--' ||
      two === '**' ||
      two === '+=' ||
      two === '-=' ||
      two === '*=' ||
      two === '/=' ||
      two === '%=' ||
      two === '&=' ||
      two === '|=' ||
      two === '^='
    ) {
      tokens.push({ kind: 'punct', value: two, start: pos, end: pos + 2, lineBefore });
      lineBefore = false;
      pos += 2;
      continue;
    }

    tokens.push({ kind: 'punct', value: ch, start: pos, end: pos + 1, lineBefore });
    lineBefore = false;
    pos += 1;
  }

  return tokens;
}

function blankRange(chars: string[], start: number, end: number): void {
  for (let i = start; i < end; i += 1) {
    const ch = chars[i];
    if (ch !== '\n' && ch !== '\r') {
      chars[i] = ' ';
    }
  }
}

function findMatchingDelimiter(
  tokens: readonly Token[],
  openIdx: number,
  openVal: string,
  closeVal: string,
): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok.kind === 'punct') {
      if (tok.value === openVal) {
        depth += 1;
      } else if (tok.value === closeVal) {
        depth -= 1;
        if (depth === 0) return i;
      }
    } else if (tok.kind === 'template_head') {
      // Skip until matching template_tail
      let tDepth = 1;
      i += 1;
      while (i < tokens.length && tDepth > 0) {
        if (tokens[i].kind === 'template_head') tDepth += 1;
        else if (tokens[i].kind === 'template_tail') tDepth -= 1;
        i += 1;
      }
      i -= 1;
    }
  }
  throw invalidSyntaxError(`Unclosed '${openVal}'`);
}

function parseBalancedAngles(tokens: readonly Token[], openIdx: number): number {
  if (tokens[openIdx]?.kind !== 'punct' || tokens[openIdx]?.value !== '<') {
    throw invalidSyntaxError("Expected '<'");
  }
  let angleDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let i = openIdx; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok.kind !== 'punct') continue;
    switch (tok.value) {
      case '(':
        parenDepth += 1;
        break;
      case ')':
        parenDepth -= 1;
        if (parenDepth < 0) throw invalidSyntaxError("Unexpected ')' in type arguments");
        break;
      case '{':
        braceDepth += 1;
        break;
      case '}':
        braceDepth -= 1;
        if (braceDepth < 0) throw invalidSyntaxError("Unexpected '}' in type arguments");
        break;
      case '[':
        bracketDepth += 1;
        break;
      case ']':
        bracketDepth -= 1;
        if (bracketDepth < 0) throw invalidSyntaxError("Unexpected ']' in type arguments");
        break;
      case '<':
        if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
          angleDepth += 1;
        }
        break;
      case '>':
        if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
          angleDepth -= 1;
          if (angleDepth === 0) return i + 1;
        }
        break;
      case ';':
        if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
          throw invalidSyntaxError("Unexpected ';' in type arguments");
        }
        break;
    }
  }
  throw invalidSyntaxError("Unclosed '<'");
}

function tryParseBalancedAngles(tokens: readonly Token[], openIdx: number): number | -1 {
  try {
    const first = tokens[openIdx + 1];
    if (!first) return -1;
    if (first.kind === 'punct' && first.value === '=') return -1; // '<='
    if (first.kind === 'punct' && first.value === '<') return -1; // '<<'
    if (first.kind === 'punct' && first.value === '>') return -1; // '<>'
    return parseBalancedAngles(tokens, openIdx);
  } catch {
    return -1;
  }
}

/**
 * Parses a complete TypeScript type expression starting at `startIdx` and returns
 * the index of the first token AFTER the type expression.
 */
function parseType(tokens: readonly Token[], startIdx: number): number {
  let idx = startIdx;

  const parsePrimary = (): void => {
    while (
      idx < tokens.length &&
      tokens[idx].kind === 'punct' &&
      (tokens[idx].value === '|' || tokens[idx].value === '&')
    ) {
      idx += 1;
    }

    // Prefix modifiers
    while (idx < tokens.length && tokens[idx].kind === 'ident') {
      const kw = tokens[idx].value;
      if (kw === 'readonly' || kw === 'keyof' || kw === 'unique') {
        idx += 1;
        continue;
      }
      if (kw === 'infer') {
        idx += 1;
        if (tokens[idx]?.kind !== 'ident') {
          throw invalidSyntaxError('Expected identifier after infer');
        }
        idx += 1;
        if (tokens[idx]?.kind === 'ident' && tokens[idx].value === 'extends') {
          idx += 1;
          idx = parseType(tokens, idx);
        }
        return;
      }
      if (kw === 'typeof') {
        idx += 1;
        if (
          tokens[idx]?.kind === 'ident' &&
          tokens[idx].value === 'import' &&
          tokens[idx + 1]?.value === '('
        ) {
          const closeParen = findMatchingDelimiter(tokens, idx + 1, '(', ')');
          idx = closeParen + 1;
        } else if (tokens[idx]?.kind === 'ident') {
          idx += 1;
        } else {
          throw invalidSyntaxError('Expected identifier after typeof');
        }
        while (
          tokens[idx]?.kind === 'punct' &&
          tokens[idx].value === '.' &&
          tokens[idx + 1]?.kind === 'ident'
        ) {
          idx += 2;
        }
        if (tokens[idx]?.kind === 'punct' && tokens[idx].value === '<' && !tokens[idx].lineBefore) {
          const afterAngles = tryParseBalancedAngles(tokens, idx);
          if (afterAngles !== -1) idx = afterAngles;
        }
        return;
      }
      if (kw === 'asserts') {
        idx += 1;
        if (tokens[idx]?.kind === 'ident') {
          idx += 1;
          if (
            tokens[idx]?.kind === 'ident' &&
            tokens[idx].value === 'is' &&
            !tokens[idx].lineBefore
          ) {
            idx += 1;
            idx = parseType(tokens, idx);
          }
          return;
        }
        throw invalidSyntaxError('Expected identifier after asserts');
      }
      if (
        kw === 'abstract' &&
        tokens[idx + 1]?.kind === 'ident' &&
        tokens[idx + 1].value === 'new'
      ) {
        idx += 1;
        continue;
      }
      if (
        kw === 'new' &&
        tokens[idx + 1]?.kind === 'punct' &&
        (tokens[idx + 1].value === '(' || tokens[idx + 1].value === '<')
      ) {
        idx += 1;
        if (tokens[idx]?.value === '<') {
          idx = parseBalancedAngles(tokens, idx);
        }
        if (tokens[idx]?.value !== '(') {
          throw invalidSyntaxError("Expected '(' in constructor type");
        }
        const closeParen = findMatchingDelimiter(tokens, idx, '(', ')');
        idx = closeParen + 1;
        if (tokens[idx]?.kind === 'punct' && tokens[idx].value === '=>') {
          idx += 1;
          idx = parseType(tokens, idx);
        }
        return;
      }
      break;
    }

    const tok = tokens[idx];
    if (!tok) {
      throw invalidSyntaxError('Unexpected end of input in type');
    }

    // Generic function type: <T>(...) => R
    if (tok.kind === 'punct' && tok.value === '<') {
      idx = parseBalancedAngles(tokens, idx);
      if (tokens[idx]?.kind !== 'punct' || tokens[idx].value !== '(') {
        throw invalidSyntaxError("Expected '(' after type parameters in function type");
      }
      const closeParen = findMatchingDelimiter(tokens, idx, '(', ')');
      idx = closeParen + 1;
      if (tokens[idx]?.kind !== 'punct' || tokens[idx].value !== '=>') {
        throw invalidSyntaxError("Expected '=>' in function type");
      }
      idx += 1;
      idx = parseType(tokens, idx);
      return;
    }

    // Parenthesized type or function type: (...) or (...) => R
    if (tok.kind === 'punct' && tok.value === '(') {
      const closeParen = findMatchingDelimiter(tokens, idx, '(', ')');
      idx = closeParen + 1;
      if (tokens[idx]?.kind === 'punct' && tokens[idx].value === '=>') {
        idx += 1;
        idx = parseType(tokens, idx);
      }
      return;
    }

    // Object / mapped type: { ... }
    if (tok.kind === 'punct' && tok.value === '{') {
      const closeBrace = findMatchingDelimiter(tokens, idx, '{', '}');
      idx = closeBrace + 1;
      return;
    }

    // Tuple type: [ ... ]
    if (tok.kind === 'punct' && tok.value === '[') {
      const closeBracket = findMatchingDelimiter(tokens, idx, '[', ']');
      idx = closeBracket + 1;
      return;
    }

    // Negative / positive numeric literal type: -1, +1
    if (
      tok.kind === 'punct' &&
      (tok.value === '-' || tok.value === '+') &&
      tokens[idx + 1]?.kind === 'number'
    ) {
      idx += 2;
      return;
    }

    // String / number / template literal types
    if (tok.kind === 'string' || tok.kind === 'number' || tok.kind === 'template_no_sub') {
      idx += 1;
      return;
    }
    if (tok.kind === 'template_head') {
      idx += 1;
      for (;;) {
        idx = parseType(tokens, idx);
        const term = tokens[idx];
        if (!term) throw invalidSyntaxError('Unterminated template literal type');
        if (term.kind === 'template_tail') {
          idx += 1;
          break;
        }
        if (term.kind === 'template_middle') {
          idx += 1;
          continue;
        }
        throw invalidSyntaxError('Invalid template literal type');
      }
      return;
    }

    // import('...').Foo<T>
    if (tok.kind === 'ident' && tok.value === 'import' && tokens[idx + 1]?.value === '(') {
      const closeParen = findMatchingDelimiter(tokens, idx + 1, '(', ')');
      idx = closeParen + 1;
      while (
        tokens[idx]?.kind === 'punct' &&
        tokens[idx].value === '.' &&
        tokens[idx + 1]?.kind === 'ident'
      ) {
        idx += 2;
      }
      if (tokens[idx]?.kind === 'punct' && tokens[idx].value === '<' && !tokens[idx].lineBefore) {
        const afterAngles = tryParseBalancedAngles(tokens, idx);
        if (afterAngles !== -1) idx = afterAngles;
      }
      return;
    }

    // Identifier / qualified name / built-in type
    if (tok.kind === 'ident') {
      const firstIdent = tok.value;
      idx += 1;
      for (;;) {
        if (
          tokens[idx]?.kind === 'punct' &&
          tokens[idx].value === '.' &&
          tokens[idx + 1]?.kind === 'ident'
        ) {
          idx += 2;
          continue;
        }
        if (tokens[idx]?.kind === 'punct' && tokens[idx].value === '<' && !tokens[idx].lineBefore) {
          const afterAngles = tryParseBalancedAngles(tokens, idx);
          if (afterAngles !== -1) {
            idx = afterAngles;
            continue;
          }
        }
        break;
      }
      // Type predicate: `x is Foo` or `this is Foo`
      if (
        tokens[idx]?.kind === 'ident' &&
        tokens[idx].value === 'is' &&
        !tokens[idx].lineBefore &&
        firstIdent !== 'true' &&
        firstIdent !== 'false' &&
        firstIdent !== 'null'
      ) {
        idx += 1;
        idx = parseType(tokens, idx);
      }
      return;
    }

    throw invalidSyntaxError(`Unexpected token \`${tok.value}\``);
  };

  const parsePrimaryWithPostfix = (): void => {
    parsePrimary();
    while (
      idx < tokens.length &&
      tokens[idx].kind === 'punct' &&
      tokens[idx].value === '[' &&
      !tokens[idx].lineBefore
    ) {
      const closeBracket = findMatchingDelimiter(tokens, idx, '[', ']');
      idx = closeBracket + 1;
    }
  };

  parsePrimaryWithPostfix();

  for (;;) {
    const next = tokens[idx];
    if (!next) break;
    if (next.kind === 'punct' && (next.value === '|' || next.value === '&')) {
      idx += 1;
      parsePrimaryWithPostfix();
      continue;
    }
    if (next.kind === 'ident' && next.value === 'extends' && !next.lineBefore) {
      // Conditional type: Check extends Extends ? TrueType : FalseType
      const saved = idx;
      idx += 1;
      idx = parseType(tokens, idx);
      if (tokens[idx]?.kind === 'punct' && tokens[idx].value === '?') {
        idx += 1;
        idx = parseType(tokens, idx);
        if (tokens[idx]?.kind !== 'punct' || tokens[idx].value !== ':') {
          throw invalidSyntaxError("Expected ':' in conditional type");
        }
        idx += 1;
        idx = parseType(tokens, idx);
        continue;
      }
      idx = saved;
      break;
    }
    break;
  }

  return idx;
}

function skipStatementEnd(tokens: readonly Token[], idx: number): number {
  let i = idx;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.kind === 'punct' && tok.value === ';') {
      return i + 1;
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const closeBrace = findMatchingDelimiter(tokens, i, '{', '}');
      return closeBrace + 1;
    }
    if (tok.kind === 'punct' && tok.value === '(') {
      i = findMatchingDelimiter(tokens, i, '(', ')') + 1;
      continue;
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      i = findMatchingDelimiter(tokens, i, '[', ']') + 1;
      continue;
    }
    if (i > idx && tok.lineBefore) {
      return i;
    }
    i += 1;
  }
  return i;
}

function stripParameterList(
  chars: string[],
  tokens: readonly Token[],
  openParenIdx: number,
  closeParenIdx: number,
  isConstructor: boolean,
  mode: 'strip' | 'transform',
): string[] {
  const paramProps: string[] = [];
  let i = openParenIdx + 1;

  // Handle leading `this: Type` fake parameter
  if (
    i < closeParenIdx &&
    tokens[i].kind === 'ident' &&
    tokens[i].value === 'this' &&
    tokens[i + 1]?.kind === 'punct' &&
    tokens[i + 1].value === ':'
  ) {
    const afterThisType = parseType(tokens, i + 2);
    let endBlank = tokens[afterThisType - 1].end;
    let nextIdx = afterThisType;
    if (
      nextIdx < closeParenIdx &&
      tokens[nextIdx].kind === 'punct' &&
      tokens[nextIdx].value === ','
    ) {
      endBlank = tokens[nextIdx].end;
      nextIdx += 1;
    }
    blankRange(chars, tokens[i].start, endBlank);
    i = nextIdx;
  }

  while (i < closeParenIdx) {
    // Parameter decorators or modifiers
    while (
      i < closeParenIdx &&
      tokens[i].kind === 'ident' &&
      ACCESS_MODIFIERS.has(tokens[i].value)
    ) {
      if (!isConstructor || mode === 'strip') {
        throw unsupportedSyntaxError(
          'TypeScript parameter property is not supported in strip-only mode',
        );
      }
      blankRange(chars, tokens[i].start, tokens[i].end);
      i += 1;
      if (
        i < closeParenIdx &&
        tokens[i].kind === 'ident' &&
        !ACCESS_MODIFIERS.has(tokens[i].value)
      ) {
        paramProps.push(tokens[i].value);
      }
    }

    if (i < closeParenIdx && tokens[i].kind === 'punct' && tokens[i].value === '...') {
      i += 1;
    }

    // Parameter pattern (ident, { ... }, [ ... ])
    if (i < closeParenIdx) {
      const pat = tokens[i];
      if (pat.kind === 'ident') {
        i += 1;
      } else if (pat.kind === 'punct' && pat.value === '{') {
        const close = findMatchingDelimiter(tokens, i, '{', '}');
        stripTokensRange(chars, tokens, i + 1, close, mode);
        i = close + 1;
      } else if (pat.kind === 'punct' && pat.value === '[') {
        const close = findMatchingDelimiter(tokens, i, '[', ']');
        stripTokensRange(chars, tokens, i + 1, close, mode);
        i = close + 1;
      }
    }

    // Optional '?' on parameter
    if (i < closeParenIdx && tokens[i].kind === 'punct' && tokens[i].value === '?') {
      blankRange(chars, tokens[i].start, tokens[i].end);
      i += 1;
    }

    // Parameter ': Type'
    if (i < closeParenIdx && tokens[i].kind === 'punct' && tokens[i].value === ':') {
      const colonStart = tokens[i].start;
      const afterType = parseType(tokens, i + 1);
      blankRange(chars, colonStart, tokens[afterType - 1].end);
      i = afterType;
    }

    // Default value '= expr' up to top-level ',' or closeParenIdx
    if (i < closeParenIdx && tokens[i].kind === 'punct' && tokens[i].value === '=') {
      const eqIdx = i;
      i += 1;
      const exprStart = i;
      while (i < closeParenIdx) {
        const tok = tokens[i];
        if (tok.kind === 'punct') {
          if (tok.value === '(') {
            i = findMatchingDelimiter(tokens, i, '(', ')') + 1;
            continue;
          }
          if (tok.value === '{') {
            i = findMatchingDelimiter(tokens, i, '{', '}') + 1;
            continue;
          }
          if (tok.value === '[') {
            i = findMatchingDelimiter(tokens, i, '[', ']') + 1;
            continue;
          }
          if (tok.value === ',') break;
        }
        i += 1;
      }
      if (i > exprStart) {
        stripTokensRange(chars, tokens, eqIdx + 1, i, mode);
      }
    }

    if (i < closeParenIdx && tokens[i].kind === 'punct' && tokens[i].value === ',') {
      i += 1;
    } else if (i < closeParenIdx) {
      i += 1;
    }
  }

  return paramProps;
}

function stripClassBody(
  chars: string[],
  tokens: readonly Token[],
  openBraceIdx: number,
  closeBraceIdx: number,
  mode: 'strip' | 'transform',
  constructorInsertions: Array<{ pos: number; text: string }>,
): void {
  let i = openBraceIdx + 1;
  while (i < closeBraceIdx) {
    if (tokens[i].kind === 'punct' && tokens[i].value === ';') {
      i += 1;
      continue;
    }

    // Decorators `@expr` - pass through so acorn or runtime sees them if any
    if (tokens[i].kind === 'punct' && tokens[i].value === '@') {
      i += 1;
      continue;
    }

    // Static initialization block `static { ... }`
    if (
      tokens[i].kind === 'ident' &&
      tokens[i].value === 'static' &&
      tokens[i + 1]?.kind === 'punct' &&
      tokens[i + 1].value === '{'
    ) {
      const endStatic = findMatchingDelimiter(tokens, i + 1, '{', '}');
      stripTokensRange(chars, tokens, i + 2, endStatic, mode);
      i = endStatic + 1;
      continue;
    }

    const memberStart = tokens[i].start;
    let isDeclareMember = false;
    let isAbstractMember = false;

    // Index signature: `[key: string]: ValueType;`
    if (
      tokens[i].kind === 'punct' &&
      tokens[i].value === '[' &&
      tokens[i + 1]?.kind === 'ident' &&
      tokens[i + 2]?.kind === 'punct' &&
      tokens[i + 2].value === ':'
    ) {
      const closeBracket = findMatchingDelimiter(tokens, i, '[', ']');
      if (tokens[closeBracket + 1]?.kind === 'punct' && tokens[closeBracket + 1].value === ':') {
        const afterType = parseType(tokens, closeBracket + 2);
        let endIdx = afterType;
        if (tokens[endIdx]?.kind === 'punct' && tokens[endIdx].value === ';') endIdx += 1;
        blankRange(chars, memberStart, tokens[endIdx - 1].end);
        i = endIdx;
        continue;
      }
    }

    // Consume member modifiers
    while (i < closeBraceIdx && tokens[i].kind === 'ident') {
      const mod = tokens[i].value;
      const nextTok = tokens[i + 1];
      const nextIsMemberFollow =
        nextTok !== undefined &&
        (nextTok.kind === 'ident' ||
          nextTok.kind === 'string' ||
          nextTok.kind === 'number' ||
          (nextTok.kind === 'punct' && (nextTok.value === '[' || nextTok.value === '*')));
      if (!nextIsMemberFollow) break;

      if (ACCESS_MODIFIERS.has(mod)) {
        blankRange(chars, tokens[i].start, tokens[i].end);
        i += 1;
        continue;
      }
      if (mod === 'declare') {
        isDeclareMember = true;
        blankRange(chars, tokens[i].start, tokens[i].end);
        i += 1;
        continue;
      }
      if (mod === 'abstract') {
        isAbstractMember = true;
        blankRange(chars, tokens[i].start, tokens[i].end);
        i += 1;
        continue;
      }
      if (mod === 'static' || mod === 'async' || mod === 'accessor') {
        i += 1;
        continue;
      }
      if (
        (mod === 'get' || mod === 'set') &&
        nextTok.value !== '(' &&
        nextTok.value !== ':' &&
        nextTok.value !== '='
      ) {
        i += 1;
        continue;
      }
      break;
    }

    // Index signature after `readonly` modifier: `readonly [k: string]: number;`
    if (
      i < closeBraceIdx &&
      tokens[i].kind === 'punct' &&
      tokens[i].value === '[' &&
      tokens[i + 1]?.kind === 'ident' &&
      tokens[i + 2]?.kind === 'punct' &&
      tokens[i + 2].value === ':'
    ) {
      const closeBracket = findMatchingDelimiter(tokens, i, '[', ']');
      if (tokens[closeBracket + 1]?.kind === 'punct' && tokens[closeBracket + 1].value === ':') {
        const afterType = parseType(tokens, closeBracket + 2);
        let endIdx = afterType;
        if (tokens[endIdx]?.kind === 'punct' && tokens[endIdx].value === ';') endIdx += 1;
        blankRange(chars, memberStart, tokens[endIdx - 1].end);
        i = endIdx;
        continue;
      }
    }

    if (i < closeBraceIdx && tokens[i].kind === 'punct' && tokens[i].value === '*') {
      i += 1;
    }

    // Member name
    let isConstructor = false;
    if (i < closeBraceIdx) {
      const nameTok = tokens[i];
      if (nameTok.kind === 'ident') {
        isConstructor = nameTok.value === 'constructor';
        i += 1;
      } else if (nameTok.kind === 'string' || nameTok.kind === 'number') {
        i += 1;
      } else if (nameTok.kind === 'punct' && nameTok.value === '[') {
        const closeComputed = findMatchingDelimiter(tokens, i, '[', ']');
        stripTokensRange(chars, tokens, i + 1, closeComputed, mode);
        i = closeComputed + 1;
      } else {
        i += 1;
        continue;
      }
    }

    // Optional '?' or definite '!' on field/method
    if (
      i < closeBraceIdx &&
      tokens[i].kind === 'punct' &&
      (tokens[i].value === '?' || tokens[i].value === '!')
    ) {
      blankRange(chars, tokens[i].start, tokens[i].end);
      i += 1;
    }

    // Method type parameters `<T>`
    if (i < closeBraceIdx && tokens[i].kind === 'punct' && tokens[i].value === '<') {
      const afterAngles = parseBalancedAngles(tokens, i);
      blankRange(chars, tokens[i].start, tokens[afterAngles - 1].end);
      i = afterAngles;
    }

    // Method `(params)`
    if (i < closeBraceIdx && tokens[i].kind === 'punct' && tokens[i].value === '(') {
      const closeParen = findMatchingDelimiter(tokens, i, '(', ')');
      const paramProps = stripParameterList(chars, tokens, i, closeParen, isConstructor, mode);
      i = closeParen + 1;

      if (i < closeBraceIdx && tokens[i].kind === 'punct' && tokens[i].value === ':') {
        const colonStart = tokens[i].start;
        const afterRet = parseType(tokens, i + 1);
        blankRange(chars, colonStart, tokens[afterRet - 1].end);
        i = afterRet;
      }

      if (i < closeBraceIdx && tokens[i].kind === 'punct' && tokens[i].value === '{') {
        const bodyClose = findMatchingDelimiter(tokens, i, '{', '}');
        if (paramProps.length > 0 && mode === 'transform') {
          const assignCode = paramProps.map((p) => `this.${p} = ${p};`).join(' ');
          // Insert after super(...) if first statement in constructor is super(...)
          let insertAt = tokens[i].end;
          if (
            tokens[i + 1]?.kind === 'ident' &&
            tokens[i + 1].value === 'super' &&
            tokens[i + 2]?.kind === 'punct' &&
            tokens[i + 2].value === '('
          ) {
            const closeSuper = findMatchingDelimiter(tokens, i + 2, '(', ')');
            let afterSuper = closeSuper + 1;
            if (tokens[afterSuper]?.kind === 'punct' && tokens[afterSuper].value === ';') {
              afterSuper += 1;
            }
            insertAt = tokens[afterSuper - 1].end;
            constructorInsertions.push({ pos: insertAt, text: `; ${assignCode}` });
          } else {
            constructorInsertions.push({ pos: insertAt, text: ` ${assignCode}` });
          }
        }
        stripTokensRange(chars, tokens, i + 1, bodyClose, mode, constructorInsertions);
        i = bodyClose + 1;
      } else {
        // Method overload signature or abstract method without body -> blank entire member!
        let endIdx = i;
        if (
          endIdx < closeBraceIdx &&
          tokens[endIdx].kind === 'punct' &&
          tokens[endIdx].value === ';'
        ) {
          endIdx += 1;
        }
        blankRange(chars, memberStart, tokens[endIdx - 1].end);
        i = endIdx;
      }
      continue;
    }

    // Class field `: Type` and/or `= initializer`
    if (i < closeBraceIdx && tokens[i].kind === 'punct' && tokens[i].value === ':') {
      const colonStart = tokens[i].start;
      const afterFieldType = parseType(tokens, i + 1);
      blankRange(chars, colonStart, tokens[afterFieldType - 1].end);
      i = afterFieldType;
    }

    if (isDeclareMember || isAbstractMember) {
      let endIdx = i;
      if (
        endIdx < closeBraceIdx &&
        tokens[endIdx].kind === 'punct' &&
        tokens[endIdx].value === ';'
      ) {
        endIdx += 1;
      }
      blankRange(chars, memberStart, tokens[endIdx - 1].end);
      i = endIdx;
      continue;
    }

    if (i < closeBraceIdx && tokens[i].kind === 'punct' && tokens[i].value === '=') {
      const initStart = i + 1;
      let j = initStart;
      while (j < closeBraceIdx) {
        const tok = tokens[j];
        if (tok.kind === 'punct') {
          if (tok.value === '(') {
            j = findMatchingDelimiter(tokens, j, '(', ')') + 1;
            continue;
          }
          if (tok.value === '{') {
            j = findMatchingDelimiter(tokens, j, '{', '}') + 1;
            continue;
          }
          if (tok.value === '[') {
            j = findMatchingDelimiter(tokens, j, '[', ']') + 1;
            continue;
          }
          if (tok.value === ';') break;
        }
        if (j > initStart && tok.lineBefore && tok.kind === 'ident') {
          // Heuristic only if not binary operator continuation; semicolon usually terminates
        }
        j += 1;
      }
      stripTokensRange(chars, tokens, initStart, j, mode, constructorInsertions);
      i = j;
      if (i < closeBraceIdx && tokens[i].kind === 'punct' && tokens[i].value === ';') {
        i += 1;
      }
    }
  }
}

function isTypeOnlyNamespaceDeclaration(tokens: readonly Token[], nsKeywordIdx: number): boolean {
  // Check `namespace Foo { ... }`: in TS, non-ambient `namespace` with only types/interfaces IS allowed in some tools,
  // but Node 22.18 amaro throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX on any non-ambient `namespace` declaration!
  const next = tokens[nsKeywordIdx + 1];
  return next !== undefined && (next.kind === 'ident' || next.kind === 'string');
}

function stripTokensRange(
  chars: string[],
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
  mode: 'strip' | 'transform',
  insertions: Array<{ pos: number; text: string }> = [],
): void {
  let i = startIdx;

  while (i < endIdx) {
    const tok = tokens[i];

    // Check `export` prefix before TS declarations
    let exportStart = -1;
    let declIdx = i;
    if (tok.kind === 'ident' && tok.value === 'export') {
      exportStart = tok.start;
      declIdx = i + 1;

      // `export = expr`
      if (tokens[declIdx]?.kind === 'punct' && tokens[declIdx].value === '=') {
        throw unsupportedSyntaxError(
          'TypeScript export assignment is not supported in strip-only mode',
        );
      }

      // `export type * ...` or `export type { ... }`
      if (
        tokens[declIdx]?.kind === 'ident' &&
        tokens[declIdx].value === 'type' &&
        tokens[declIdx + 1]?.kind === 'punct' &&
        (tokens[declIdx + 1].value === '{' || tokens[declIdx + 1].value === '*')
      ) {
        let after = declIdx + 2;
        if (tokens[declIdx + 1].value === '{') {
          after = findMatchingDelimiter(tokens, declIdx + 1, '{', '}') + 1;
        } else if (tokens[after]?.kind === 'ident' && tokens[after].value === 'as') {
          after += 2;
        }
        if (tokens[after]?.kind === 'ident' && tokens[after].value === 'from') {
          after += 2; // 'from' + specifier
        }
        if (tokens[after]?.kind === 'punct' && tokens[after].value === ';') {
          after += 1;
        }
        blankRange(chars, exportStart, tokens[after - 1].end);
        i = after;
        continue;
      }

      // `export { type A, b }` inline type specifiers
      if (tokens[declIdx]?.kind === 'punct' && tokens[declIdx].value === '{') {
        const closeBrace = findMatchingDelimiter(tokens, declIdx, '{', '}');
        stripImportOrExportSpecifiers(chars, tokens, declIdx + 1, closeBrace);
        i = closeBrace + 1;
        continue;
      }
    }

    const cur = tokens[declIdx];
    if (!cur || declIdx >= endIdx) {
      i += 1;
      continue;
    }

    // `declare ...` ambient declaration (including `export declare ...`)
    if (
      cur.kind === 'ident' &&
      cur.value === 'declare' &&
      tokens[declIdx + 1] !== undefined &&
      !tokens[declIdx + 1].lineBefore &&
      tokens[declIdx + 1].kind === 'ident'
    ) {
      const startBlank = exportStart !== -1 ? exportStart : cur.start;
      const afterDecl = skipAmbientDeclaration(tokens, declIdx + 1);
      blankRange(chars, startBlank, tokens[afterDecl - 1].end);
      i = afterDecl;
      continue;
    }

    // `interface Name<...> extends ... { ... }`
    if (
      cur.kind === 'ident' &&
      cur.value === 'interface' &&
      tokens[declIdx + 1] !== undefined &&
      !tokens[declIdx + 1].lineBefore &&
      tokens[declIdx + 1].kind === 'ident'
    ) {
      const startBlank = exportStart !== -1 ? exportStart : cur.start;
      let j = declIdx + 2;
      if (tokens[j]?.kind === 'punct' && tokens[j].value === '<') {
        j = parseBalancedAngles(tokens, j);
      }
      while (j < endIdx && !(tokens[j].kind === 'punct' && tokens[j].value === '{')) {
        j += 1;
      }
      if (tokens[j]?.kind !== 'punct' || tokens[j].value !== '{') {
        throw invalidSyntaxError("Expected '{' in interface declaration");
      }
      const closeBrace = findMatchingDelimiter(tokens, j, '{', '}');
      blankRange(chars, startBlank, tokens[closeBrace].end);
      i = closeBrace + 1;
      continue;
    }

    // `type Alias<...> = Type;`
    if (
      cur.kind === 'ident' &&
      cur.value === 'type' &&
      tokens[declIdx + 1] !== undefined &&
      !tokens[declIdx + 1].lineBefore &&
      tokens[declIdx + 1].kind === 'ident'
    ) {
      let j = declIdx + 2;
      if (tokens[j]?.kind === 'punct' && tokens[j].value === '<') {
        j = parseBalancedAngles(tokens, j);
      }
      if (tokens[j]?.kind === 'punct' && tokens[j].value === '=') {
        const startBlank = exportStart !== -1 ? exportStart : cur.start;
        let afterType = parseType(tokens, j + 1);
        if (tokens[afterType]?.kind === 'punct' && tokens[afterType].value === ';') {
          afterType += 1;
        }
        blankRange(chars, startBlank, tokens[afterType - 1].end);
        i = afterType;
        continue;
      }
    }

    // `enum` / `const enum`
    const isConstEnum =
      cur.kind === 'ident' &&
      cur.value === 'const' &&
      tokens[declIdx + 1]?.kind === 'ident' &&
      tokens[declIdx + 1].value === 'enum' &&
      !tokens[declIdx + 1].lineBefore;
    const isPlainEnum = cur.kind === 'ident' && cur.value === 'enum';
    if (isConstEnum || isPlainEnum) {
      const enumKwIdx = isConstEnum ? declIdx + 1 : declIdx;
      const nameTok = tokens[enumKwIdx + 1];
      if (nameTok?.kind === 'ident' && tokens[enumKwIdx + 2]?.value === '{') {
        if (mode === 'strip') {
          throw unsupportedSyntaxError('TypeScript enum is not supported in strip-only mode');
        }
        const closeBrace = findMatchingDelimiter(tokens, enumKwIdx + 2, '{', '}');
        const lowered = lowerEnum(
          nameTok.value,
          tokens,
          enumKwIdx + 2,
          closeBrace,
          exportStart !== -1,
        );
        const startReplace = exportStart !== -1 ? exportStart : cur.start;
        blankRange(chars, startReplace, tokens[closeBrace].end);
        insertions.push({ pos: startReplace, text: lowered });
        i = closeBrace + 1;
        continue;
      }
    }

    // `namespace Foo { ... }` / `module Foo { ... }`
    if (
      cur.kind === 'ident' &&
      (cur.value === 'namespace' || cur.value === 'module') &&
      !tokens[declIdx + 1]?.lineBefore &&
      tokens[declIdx + 1]?.kind === 'ident' &&
      isTypeOnlyNamespaceDeclaration(tokens, declIdx)
    ) {
      let j = declIdx + 2;
      while (
        tokens[j]?.kind === 'punct' &&
        tokens[j].value === '.' &&
        tokens[j + 1]?.kind === 'ident'
      ) {
        j += 2;
      }
      if (tokens[j]?.kind === 'punct' && tokens[j].value === '{') {
        if (mode === 'strip') {
          throw unsupportedSyntaxError(
            'TypeScript namespace declaration is not supported in strip-only mode',
          );
        }
        const closeBrace = findMatchingDelimiter(tokens, j, '{', '}');
        const nsName = tokens[declIdx + 1].value;
        stripTokensRange(chars, tokens, j + 1, closeBrace, mode, insertions);
        const bodySlice = chars.slice(tokens[j].start + 1, tokens[closeBrace].start).join('');
        const startReplace = exportStart !== -1 ? exportStart : cur.start;
        blankRange(chars, startReplace, tokens[closeBrace].end);
        const prefix = exportStart !== -1 ? 'export ' : '';
        insertions.push({
          pos: startReplace,
          text: `${prefix}var ${nsName}; (function (${nsName}) {${bodySlice}})(${nsName} || (${nsName} = {}));`,
        });
        i = closeBrace + 1;
        continue;
      }
    }

    // `import ...`
    if (tok.kind === 'ident' && tok.value === 'import') {
      // Skip `import.meta` and `import(...)`
      if (
        tokens[i + 1]?.kind === 'punct' &&
        (tokens[i + 1].value === '.' || tokens[i + 1].value === '(')
      ) {
        i += 2;
        continue;
      }
      // `import x = require(...)`
      if (
        tokens[i + 1]?.kind === 'ident' &&
        tokens[i + 2]?.kind === 'punct' &&
        tokens[i + 2].value === '='
      ) {
        throw unsupportedSyntaxError(
          'TypeScript import equals is not supported in strip-only mode',
        );
      }
      // `import type ...` (disambiguate `import type from './x'`!)
      if (
        tokens[i + 1]?.kind === 'ident' &&
        tokens[i + 1].value === 'type' &&
        !(tokens[i + 2]?.kind === 'ident' && tokens[i + 2].value === 'from') &&
        !(tokens[i + 2]?.kind === 'punct' && tokens[i + 2].value === ',')
      ) {
        let j = i + 2;
        if (tokens[j]?.kind === 'punct' && tokens[j].value === '{') {
          j = findMatchingDelimiter(tokens, j, '{', '}') + 1;
        } else if (tokens[j]?.kind === 'punct' && tokens[j].value === '*') {
          j += 3; // * as ns
        } else if (tokens[j]?.kind === 'ident') {
          j += 1;
        }
        if (tokens[j]?.kind === 'ident' && tokens[j].value === 'from') {
          j += 2;
        }
        if (tokens[j]?.kind === 'punct' && tokens[j].value === ';') {
          j += 1;
        }
        blankRange(chars, tok.start, tokens[j - 1].end);
        i = j;
        continue;
      }
      // `import { type A, b } from '...'` or `import Def, { type A, b } from '...'`
      let j = i + 1;
      if (
        tokens[j]?.kind === 'ident' &&
        tokens[j + 1]?.kind === 'punct' &&
        tokens[j + 1].value === ','
      ) {
        j += 2;
      }
      if (tokens[j]?.kind === 'punct' && tokens[j].value === '{') {
        const closeBrace = findMatchingDelimiter(tokens, j, '{', '}');
        stripImportOrExportSpecifiers(chars, tokens, j + 1, closeBrace);
        i = closeBrace + 1;
        continue;
      }
    }

    // `[export] [default] [abstract] class Name<T> extends Base<U> implements I1, I2 { ... }`
    let classIdx = declIdx;
    let abstractIdx = -1;
    if (tokens[classIdx]?.kind === 'ident' && tokens[classIdx].value === 'default') {
      classIdx += 1;
    }
    if (
      tokens[classIdx]?.kind === 'ident' &&
      tokens[classIdx].value === 'abstract' &&
      tokens[classIdx + 1]?.kind === 'ident' &&
      tokens[classIdx + 1].value === 'class' &&
      !tokens[classIdx + 1].lineBefore
    ) {
      abstractIdx = classIdx;
      classIdx += 1;
    }
    if (tokens[classIdx]?.kind === 'ident' && tokens[classIdx].value === 'class') {
      if (abstractIdx !== -1) {
        blankRange(chars, tokens[abstractIdx].start, tokens[abstractIdx].end);
      }
      let j = classIdx + 1;
      if (tokens[j]?.kind === 'ident') {
        j += 1;
      }
      if (tokens[j]?.kind === 'punct' && tokens[j].value === '<') {
        const afterAngles = parseBalancedAngles(tokens, j);
        blankRange(chars, tokens[j].start, tokens[afterAngles - 1].end);
        j = afterAngles;
      }
      if (tokens[j]?.kind === 'ident' && tokens[j].value === 'extends') {
        j += 1;
        // Skip heritage expression (e.g. Base or ns.Base or mixin()), stripping `<TypeArgs>` before `implements` or `{`
        while (
          j < endIdx &&
          !(tokens[j].kind === 'ident' && tokens[j].value === 'implements') &&
          !(tokens[j].kind === 'punct' && tokens[j].value === '{')
        ) {
          if (tokens[j].kind === 'punct' && tokens[j].value === '(') {
            const closeP = findMatchingDelimiter(tokens, j, '(', ')');
            stripTokensRange(chars, tokens, j + 1, closeP, mode, insertions);
            j = closeP + 1;
            continue;
          }
          if (tokens[j].kind === 'punct' && tokens[j].value === '<') {
            const afterAngles = tryParseBalancedAngles(tokens, j);
            if (afterAngles !== -1) {
              blankRange(chars, tokens[j].start, tokens[afterAngles - 1].end);
              j = afterAngles;
              continue;
            }
          }
          j += 1;
        }
      }
      if (tokens[j]?.kind === 'ident' && tokens[j].value === 'implements') {
        const implStart = tokens[j].start;
        j += 1;
        while (j < endIdx && !(tokens[j].kind === 'punct' && tokens[j].value === '{')) {
          j += 1;
        }
        if (j > 0) {
          blankRange(chars, implStart, tokens[j - 1].end);
        }
      }
      if (tokens[j]?.kind === 'punct' && tokens[j].value === '{') {
        const closeClass = findMatchingDelimiter(tokens, j, '{', '}');
        stripClassBody(chars, tokens, j, closeClass, mode, insertions);
        i = closeClass + 1;
        continue;
      }
    }

    // `[export] [default] [async] function [*] [name]<T>(params): Ret { ... }` or overload `;`
    let fnIdx = declIdx;
    if (tokens[fnIdx]?.kind === 'ident' && tokens[fnIdx].value === 'default') {
      fnIdx += 1;
    }
    if (
      tokens[fnIdx]?.kind === 'ident' &&
      tokens[fnIdx].value === 'async' &&
      tokens[fnIdx + 1]?.kind === 'ident' &&
      tokens[fnIdx + 1].value === 'function' &&
      !tokens[fnIdx + 1].lineBefore
    ) {
      fnIdx += 1;
    }
    if (tokens[fnIdx]?.kind === 'ident' && tokens[fnIdx].value === 'function') {
      const fnStmtStart = exportStart !== -1 ? exportStart : tok.start;
      let j = fnIdx + 1;
      if (tokens[j]?.kind === 'punct' && tokens[j].value === '*') {
        j += 1;
      }
      if (tokens[j]?.kind === 'ident') {
        j += 1;
      }
      if (tokens[j]?.kind === 'punct' && tokens[j].value === '<') {
        const afterAngles = parseBalancedAngles(tokens, j);
        blankRange(chars, tokens[j].start, tokens[afterAngles - 1].end);
        j = afterAngles;
      }
      if (tokens[j]?.kind === 'punct' && tokens[j].value === '(') {
        const closeParen = findMatchingDelimiter(tokens, j, '(', ')');
        stripParameterList(chars, tokens, j, closeParen, false, mode);
        j = closeParen + 1;
        if (tokens[j]?.kind === 'punct' && tokens[j].value === ':') {
          const colonStart = tokens[j].start;
          const afterRet = parseType(tokens, j + 1);
          blankRange(chars, colonStart, tokens[afterRet - 1].end);
          j = afterRet;
        }
        if (tokens[j]?.kind === 'punct' && tokens[j].value === '{') {
          const closeBody = findMatchingDelimiter(tokens, j, '{', '}');
          stripTokensRange(chars, tokens, j + 1, closeBody, mode, insertions);
          i = closeBody + 1;
          continue;
        }
        // Function overload signature without `{` -> blank entire declaration!
        let endOverload = j;
        if (tokens[endOverload]?.kind === 'punct' && tokens[endOverload].value === ';') {
          endOverload += 1;
        }
        blankRange(chars, fnStmtStart, tokens[endOverload - 1].end);
        i = endOverload;
        continue;
      }
    }

    // Variable declarations `const` / `let` / `var` (including `for (const x: T of ...)`!)
    if (
      cur.kind === 'ident' &&
      (cur.value === 'const' || cur.value === 'let' || cur.value === 'var')
    ) {
      i = declIdx + 1;
      while (i < endIdx) {
        if (tokens[i].kind === 'ident') {
          i += 1;
        } else if (tokens[i].kind === 'punct' && tokens[i].value === '{') {
          const closeP = findMatchingDelimiter(tokens, i, '{', '}');
          stripTokensRange(chars, tokens, i + 1, closeP, mode, insertions);
          i = closeP + 1;
        } else if (tokens[i].kind === 'punct' && tokens[i].value === '[') {
          const closeP = findMatchingDelimiter(tokens, i, '[', ']');
          stripTokensRange(chars, tokens, i + 1, closeP, mode, insertions);
          i = closeP + 1;
        } else {
          break;
        }

        // Definite assignment `let x!: number`
        if (
          i < endIdx &&
          tokens[i].kind === 'punct' &&
          tokens[i].value === '!' &&
          !tokens[i].lineBefore
        ) {
          blankRange(chars, tokens[i].start, tokens[i].end);
          i += 1;
        }

        if (i < endIdx && tokens[i].kind === 'punct' && tokens[i].value === ':') {
          const colonStart = tokens[i].start;
          const afterVarType = parseType(tokens, i + 1);
          blankRange(chars, colonStart, tokens[afterVarType - 1].end);
          i = afterVarType;
        }

        if (i < endIdx && tokens[i].kind === 'punct' && tokens[i].value === '=') {
          const rhsStart = i + 1;
          let j = rhsStart;
          while (j < endIdx) {
            const t = tokens[j];
            if (t.kind === 'punct') {
              if (t.value === '(') {
                j = findMatchingDelimiter(tokens, j, '(', ')') + 1;
                continue;
              }
              if (t.value === '{') {
                j = findMatchingDelimiter(tokens, j, '{', '}') + 1;
                continue;
              }
              if (t.value === '[') {
                j = findMatchingDelimiter(tokens, j, '[', ']') + 1;
                continue;
              }
              if (t.value === ',' || t.value === ';') break;
            }
            if (j > rhsStart && t.lineBefore && isStatementStartToken(tokens, j)) {
              break;
            }
            j += 1;
          }
          stripTokensRange(chars, tokens, rhsStart, j, mode, insertions);
          i = j;
        }

        if (i < endIdx && tokens[i].kind === 'punct' && tokens[i].value === ',') {
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }

    // `catch (err: unknown)`
    if (
      tok.kind === 'ident' &&
      tok.value === 'catch' &&
      tokens[i + 1]?.kind === 'punct' &&
      tokens[i + 1].value === '('
    ) {
      const closeCatch = findMatchingDelimiter(tokens, i + 1, '(', ')');
      stripParameterList(chars, tokens, i + 1, closeCatch, false, mode);
      i = closeCatch + 1;
      continue;
    }

    // Generic arrow function `<T ...>(params): Ret =>`
    if (tok.kind === 'punct' && tok.value === '<') {
      const afterAngles = tryParseBalancedAngles(tokens, i);
      if (
        afterAngles !== -1 &&
        tokens[afterAngles]?.kind === 'punct' &&
        tokens[afterAngles].value === '('
      ) {
        const closeParen = findMatchingDelimiter(tokens, afterAngles, '(', ')');
        let arrowProbe = closeParen + 1;
        if (tokens[arrowProbe]?.kind === 'punct' && tokens[arrowProbe].value === ':') {
          try {
            arrowProbe = parseType(tokens, arrowProbe + 1);
          } catch {
            arrowProbe = -1;
          }
        }
        if (
          arrowProbe !== -1 &&
          tokens[arrowProbe]?.kind === 'punct' &&
          tokens[arrowProbe].value === '=>'
        ) {
          blankRange(chars, tok.start, tokens[afterAngles - 1].end);
          stripParameterList(chars, tokens, afterAngles, closeParen, false, mode);
          if (tokens[closeParen + 1]?.kind === 'punct' && tokens[closeParen + 1].value === ':') {
            blankRange(chars, tokens[closeParen + 1].start, tokens[arrowProbe - 1].end);
          }
          i = arrowProbe + 1;
          continue;
        }
      }

      // Generic call / instantiation expression `fn<A, B>(...)` or ``tag<T>`...` ``
      const prev = tokens[i - 1];
      const canHaveTypeArgs =
        prev !== undefined &&
        (prev.kind === 'ident' ||
          (prev.kind === 'punct' && (prev.value === ')' || prev.value === ']')));
      if (canHaveTypeArgs && afterAngles !== -1) {
        const follow = tokens[afterAngles];
        if (
          follow !== undefined &&
          ((follow.kind === 'punct' && follow.value === '(') ||
            follow.kind === 'template_no_sub' ||
            follow.kind === 'template_head')
        ) {
          blankRange(chars, tok.start, tokens[afterAngles - 1].end);
          i = afterAngles;
          continue;
        }
      }
    }

    // Non-generic arrow function `(a: T, b?: U): Ret =>` or object method `foo(a: T): Ret { ... }`
    if (tok.kind === 'punct' && tok.value === '(') {
      const closeParen = findMatchingDelimiter(tokens, i, '(', ')');
      const afterParen = closeParen + 1;
      let afterRet = afterParen;
      let hasRetColon = false;
      if (tokens[afterParen]?.kind === 'punct' && tokens[afterParen].value === ':') {
        try {
          afterRet = parseType(tokens, afterParen + 1);
          hasRetColon = true;
        } catch {
          hasRetColon = false;
        }
      }
      const isArrow = tokens[afterRet]?.kind === 'punct' && tokens[afterRet].value === '=>';
      // Object literal method: `ident(params): Ret {` or `[expr](params): Ret {`
      const prevTok = tokens[i - 1];
      const isControlKeyword =
        prevTok?.kind === 'ident' &&
        (prevTok.value === 'if' ||
          prevTok.value === 'for' ||
          prevTok.value === 'while' ||
          prevTok.value === 'switch' ||
          prevTok.value === 'catch' ||
          prevTok.value === 'with');
      const isObjectMethod =
        !isControlKeyword &&
        prevTok !== undefined &&
        (prevTok.kind === 'ident' ||
          prevTok.kind === 'string' ||
          prevTok.kind === 'number' ||
          (prevTok.kind === 'punct' && prevTok.value === ']')) &&
        tokens[afterRet]?.kind === 'punct' &&
        tokens[afterRet].value === '{';

      if (isArrow || isObjectMethod) {
        stripParameterList(chars, tokens, i, closeParen, false, mode);
        if (hasRetColon) {
          blankRange(chars, tokens[afterParen].start, tokens[afterRet - 1].end);
        }
        i = afterRet + 1;
        if (isObjectMethod) {
          const closeMethodBody = findMatchingDelimiter(tokens, afterRet, '{', '}');
          stripTokensRange(chars, tokens, afterRet + 1, closeMethodBody, mode, insertions);
          i = closeMethodBody + 1;
        }
        continue;
      }

      // Normal parenthesized expression / call arguments
      stripTokensRange(chars, tokens, i + 1, closeParen, mode, insertions);
      i = closeParen + 1;
      continue;
    }

    // Postfix `as Type` / `as const` / `satisfies Type` ([no LineTerminator here])
    if (
      tok.kind === 'ident' &&
      (tok.value === 'as' || tok.value === 'satisfies') &&
      !tok.lineBefore &&
      i > startIdx &&
      canEndExpressionForAssertion(tokens[i - 1])
    ) {
      const asStart = tok.start;
      const afterAs = parseType(tokens, i + 1);
      blankRange(chars, asStart, tokens[afterAs - 1].end);
      i = afterAs;
      continue;
    }

    // Postfix non-null assertion `expr!` ([no LineTerminator here])
    if (
      tok.kind === 'punct' &&
      tok.value === '!' &&
      !tok.lineBefore &&
      i > startIdx &&
      canEndExpressionForAssertion(tokens[i - 1]) &&
      !(
        tokens[i + 1]?.kind === 'punct' &&
        tokens[i + 1].value === '=' &&
        tokens[i + 1].start === tok.end
      )
    ) {
      blankRange(chars, tok.start, tok.end);
      i += 1;
      continue;
    }

    i += 1;
  }
}

function canEndExpressionForAssertion(prev: Token): boolean {
  if (
    prev.kind === 'number' ||
    prev.kind === 'string' ||
    prev.kind === 'regex' ||
    prev.kind === 'template_no_sub' ||
    prev.kind === 'template_tail'
  ) {
    return true;
  }
  if (prev.kind === 'ident') {
    return !REGEX_PRECEDING_KEYWORDS.has(prev.value);
  }
  if (prev.kind === 'punct') {
    return prev.value === ')' || prev.value === ']' || prev.value === '}' || prev.value === '!';
  }
  return false;
}

function isStatementStartToken(tokens: readonly Token[], idx: number): boolean {
  const tok = tokens[idx];
  if (tok.kind !== 'ident') return false;
  return (
    tok.value === 'const' ||
    tok.value === 'let' ||
    tok.value === 'var' ||
    tok.value === 'function' ||
    tok.value === 'class' ||
    tok.value === 'interface' ||
    tok.value === 'type' ||
    tok.value === 'enum' ||
    tok.value === 'namespace' ||
    tok.value === 'declare' ||
    tok.value === 'import' ||
    tok.value === 'export' ||
    tok.value === 'return' ||
    tok.value === 'if' ||
    tok.value === 'for' ||
    tok.value === 'while' ||
    tok.value === 'switch' ||
    tok.value === 'try' ||
    tok.value === 'throw'
  );
}

function stripImportOrExportSpecifiers(
  chars: string[],
  tokens: readonly Token[],
  startIdx: number,
  closeBraceIdx: number,
): void {
  let i = startIdx;
  while (i < closeBraceIdx) {
    // Inline `type Foo` or `type Foo as Bar` (NOT `type`, `type,`, or `type as t`!)
    if (tokens[i].kind === 'ident' && tokens[i].value === 'type') {
      const next = tokens[i + 1];
      const next2 = tokens[i + 2];
      const isModifier =
        i + 1 < closeBraceIdx &&
        next !== undefined &&
        (next.kind === 'ident' || next.kind === 'string') &&
        !(
          next.kind === 'ident' &&
          next.value === 'as' &&
          next2 !== undefined &&
          (next2.kind === 'ident' || next2.kind === 'string') &&
          (tokens[i + 3]?.value === ',' || i + 3 === closeBraceIdx)
        );
      if (isModifier) {
        const specStart = tokens[i].start;
        let j = i + 2;
        if (tokens[j]?.kind === 'ident' && tokens[j].value === 'as') {
          j += 2;
        }
        let endPos = tokens[j - 1].end;
        if (j < closeBraceIdx && tokens[j].kind === 'punct' && tokens[j].value === ',') {
          endPos = tokens[j].end;
          j += 1;
        }
        blankRange(chars, specStart, endPos);
        i = j;
        continue;
      }
    }
    while (i < closeBraceIdx && !(tokens[i].kind === 'punct' && tokens[i].value === ',')) {
      i += 1;
    }
    if (i < closeBraceIdx && tokens[i].value === ',') {
      i += 1;
    }
  }
}

function skipAmbientDeclaration(tokens: readonly Token[], idx: number): number {
  let j = idx;
  if (tokens[j]?.kind === 'ident' && tokens[j].value === 'global' && tokens[j + 1]?.value === '{') {
    return findMatchingDelimiter(tokens, j + 1, '{', '}') + 1;
  }
  if (
    tokens[j]?.kind === 'ident' &&
    (tokens[j].value === 'namespace' || tokens[j].value === 'module')
  ) {
    j += 1;
    while (
      j < tokens.length &&
      !(tokens[j].kind === 'punct' && (tokens[j].value === '{' || tokens[j].value === ';'))
    ) {
      j += 1;
    }
    if (tokens[j]?.value === '{') {
      return findMatchingDelimiter(tokens, j, '{', '}') + 1;
    }
    return tokens[j]?.value === ';' ? j + 1 : j;
  }
  return skipStatementEnd(tokens, j);
}

function lowerEnum(
  name: string,
  tokens: readonly Token[],
  openBraceIdx: number,
  closeBraceIdx: number,
  isExported: boolean,
): string {
  const members: string[] = [];
  let nextAuto = 0;
  let i = openBraceIdx + 1;
  while (i < closeBraceIdx) {
    const keyTok = tokens[i];
    if (!keyTok || (keyTok.kind === 'punct' && keyTok.value === ',')) {
      i += 1;
      continue;
    }
    const keyExpr = keyTok.kind === 'string' ? keyTok.value : JSON.stringify(keyTok.value);
    i += 1;
    if (i < closeBraceIdx && tokens[i].kind === 'punct' && tokens[i].value === '=') {
      i += 1;
      const valTokens: string[] = [];
      while (i < closeBraceIdx && !(tokens[i].kind === 'punct' && tokens[i].value === ',')) {
        valTokens.push(tokens[i].value);
        i += 1;
      }
      const valText = valTokens.join(' ');
      const numeric = Number(valText);
      if (valTokens.length === 1 && tokens[i - 1].kind === 'number' && !Number.isNaN(numeric)) {
        members.push(`${name}[${name}[${keyExpr}] = ${valText}] = ${keyExpr};`);
        nextAuto = numeric + 1;
      } else if (valTokens.length === 1 && tokens[i - 1].kind === 'string') {
        members.push(`${name}[${keyExpr}] = ${valText};`);
        nextAuto = Number.NaN;
      } else {
        members.push(`${name}[${name}[${keyExpr}] = ${valText}] = ${keyExpr};`);
        nextAuto = Number.NaN;
      }
    } else {
      const val = Number.isNaN(nextAuto) ? 0 : nextAuto;
      members.push(`${name}[${name}[${keyExpr}] = ${val}] = ${keyExpr};`);
      nextAuto = val + 1;
    }
    if (i < closeBraceIdx && tokens[i].kind === 'punct' && tokens[i].value === ',') {
      i += 1;
    }
  }
  const prefix = isExported ? 'export ' : '';
  return `${prefix}var ${name} = (function(${name}) { ${members.join(' ')} return ${name}; })(${name} || {});`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function buildIdentitySourceMapBase64(transformed: string, sourceUrl: string): string {
  const lineCount = transformed.split('\n').length;
  const mappings: string[] = [];
  for (let line = 0; line < lineCount; line += 1) {
    mappings.push(line === 0 ? 'AAAA' : 'AACA');
  }
  const map = {
    version: 3,
    sources: [sourceUrl || '<anonymous>'],
    names: [],
    mappings: mappings.join(';'),
  };
  return Buffer.from(JSON.stringify(map)).toString('base64');
}

export function stripTypeScriptTypes(
  code: unknown,
  options?: unknown,
  emitExperimentalWarning?: () => void,
): string {
  emitExperimentalWarning?.();

  if (typeof code !== 'string') {
    throw invalidArgType('code', 'string', code);
  }

  let resolvedOptions: Record<string, unknown> = {};
  if (options !== undefined) {
    if (!isPlainObject(options)) {
      throw invalidArgType('options', 'object', options);
    }
    resolvedOptions = options;
  }

  const rawMode = resolvedOptions.mode === undefined ? 'strip' : resolvedOptions.mode;
  const rawSourceMap = resolvedOptions.sourceMap === undefined ? false : resolvedOptions.sourceMap;
  const rawSourceUrl = resolvedOptions.sourceUrl === undefined ? '' : resolvedOptions.sourceUrl;

  if (rawMode !== 'strip' && rawMode !== 'transform') {
    throw invalidArgValue('options.mode', rawMode, "must be one of: 'strip', 'transform'");
  }
  if (typeof rawSourceMap !== 'boolean') {
    throw invalidArgType('options.sourceMap', 'boolean', rawSourceMap);
  }
  if (typeof rawSourceUrl !== 'string') {
    throw invalidArgType('options.sourceUrl', 'string', rawSourceUrl);
  }
  if (rawMode === 'strip' && rawSourceMap !== false) {
    throw invalidArgValue('options.sourceMap', rawSourceMap, 'must be one of: false, undefined');
  }

  const tokens = tokenize(code);
  const chars = Array.from(code);
  const insertions: Array<{ pos: number; text: string }> = [];

  stripTokensRange(chars, tokens, 0, tokens.length, rawMode, insertions);

  let output = chars.join('');
  if (insertions.length > 0) {
    const sorted = insertions.slice().sort((a, b) => b.pos - a.pos);
    for (const ins of sorted) {
      output = output.slice(0, ins.pos) + ins.text + output.slice(ins.pos);
    }
  }

  // Validate resulting JavaScript syntax via Acorn so malformed inputs raise ERR_INVALID_TYPESCRIPT_SYNTAX
  try {
    acornParse(output, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowHashBang: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid TypeScript syntax';
    throw invalidSyntaxError(msg);
  }

  if (rawMode === 'transform' && rawSourceMap) {
    const b64 = buildIdentitySourceMapBase64(output, rawSourceUrl);
    return `${output}\n\n//# sourceMappingURL=data:application/json;base64,${b64}`;
  }

  if (rawSourceUrl) {
    return `${output}\n\n//# sourceURL=${rawSourceUrl}`;
  }

  return output;
}
