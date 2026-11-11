import { invalidArgType } from './node-errors';

const VLQ_BASE_SHIFT = 5;
const VLQ_BASE_MASK = (1 << 5) - 1;
const VLQ_CONTINUATION_MASK = 1 << 5;
const BASE64_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

let base64Map: Record<string, number> | undefined;

function getBase64Map(): Record<string, number> {
  if (!base64Map) {
    const map: Record<string, number> = Object.create(null);
    for (let i = 0; i < BASE64_DIGITS.length; i += 1) {
      map[BASE64_DIGITS[i]] = i;
    }
    base64Map = map;
  }
  return base64Map;
}

class StringCharIterator {
  readonly #string: string;
  #position = 0;

  constructor(value: string) {
    this.#string = value;
  }

  next(): string {
    const ch = this.#string.charAt(this.#position);
    this.#position += 1;
    return ch;
  }

  peek(): string {
    return this.#string.charAt(this.#position);
  }

  hasNext(): boolean {
    return this.#position < this.#string.length;
  }
}

function isSeparator(char: string): boolean {
  return char === ',' || char === ';';
}

function decodeVLQ(iterator: StringCharIterator): number {
  const map = getBase64Map();
  let result = 0;
  let shift = 0;
  let digit = 0;
  do {
    digit = map[iterator.next()] ?? 0;
    result += (digit & VLQ_BASE_MASK) << shift;
    shift += VLQ_BASE_SHIFT;
  } while (digit & VLQ_CONTINUATION_MASK);

  const negative = result & 1;
  result >>>= 1;
  if (!negative) {
    return result;
  }
  return -result | (1 << 31);
}

type MappingTuple =
  | [generatedLine: number, generatedColumn: number]
  | [
      generatedLine: number,
      generatedColumn: number,
      originalSource: string | undefined,
      originalLine: number,
      originalColumn: number,
      name: string | undefined,
    ];

export interface SourceMapSection {
  offset: { line: number; column: number };
  map: SourceMapPayload;
}

export interface SourceMapPayload {
  version: number;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: Array<string | null>;
  names?: string[];
  mappings: string;
  sections?: SourceMapSection[];
  [key: string]: unknown;
}

export interface SourceMapConstructorOptions {
  lineLengths?: readonly number[];
}

export interface SourceMapEntry {
  generatedLine?: number;
  generatedColumn?: number;
  originalSource?: string;
  originalLine?: number;
  originalColumn?: number;
  name?: string;
}

export interface SourceOrigin {
  name?: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneSourceMapV3(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw invalidArgType('payload', 'object', payload);
  }
  const copy: Record<string, unknown> = { ...payload };
  for (const key of Object.keys(copy)) {
    const val = copy[key];
    if (Array.isArray(val)) {
      copy[key] = val.slice();
    }
  }
  return copy;
}

function compareSourceMapEntry(a: MappingTuple, b: MappingTuple): number {
  if (a[0] !== b[0]) {
    return a[0] - b[0];
  }
  return a[1] - b[1];
}

export const kMappings = Symbol('kMappings');

export class SourceMap {
  readonly #payload: Record<string, unknown>;
  readonly #mappings: MappingTuple[] = [];
  readonly #lineLengths: number[] | undefined;

  constructor(payload: unknown, options?: SourceMapConstructorOptions) {
    getBase64Map();
    this.#payload = cloneSourceMapV3(payload);
    if (options !== undefined && options !== null && typeof options === 'object') {
      const maybeLineLengths = Reflect.get(options, 'lineLengths');
      if (Array.isArray(maybeLineLengths) && maybeLineLengths.length > 0) {
        this.#lineLengths = maybeLineLengths.map((n) => Number(n));
      }
    }
    this.#parseMappingPayload();
  }

  get payload(): Record<string, unknown> {
    return cloneSourceMapV3(this.#payload);
  }

  get [kMappings](): readonly MappingTuple[] {
    return this.#mappings;
  }

  get lineLengths(): number[] | undefined {
    return this.#lineLengths ? this.#lineLengths.slice() : undefined;
  }

  #parseMappingPayload(): void {
    const sections = this.#payload.sections;
    if (Array.isArray(sections)) {
      for (const section of sections) {
        if (isRecord(section) && isRecord(section.offset) && isRecord(section.map)) {
          const line = typeof section.offset.line === 'number' ? section.offset.line : 0;
          const column = typeof section.offset.column === 'number' ? section.offset.column : 0;
          this.#parseMap(section.map, line, column);
        }
      }
    } else {
      this.#parseMap(this.#payload, 0, 0);
    }
    this.#mappings.sort(compareSourceMapEntry);
  }

  #parseMap(map: Record<string, unknown>, initialLine: number, initialColumn: number): void {
    let lineNumber = initialLine;
    let columnNumber = initialColumn;
    let sourceIndex = 0;
    let sourceLineNumber = 0;
    let sourceColumnNumber = 0;
    let nameIndex = 0;

    const rawSources = Array.isArray(map.sources) ? map.sources : [];
    const sources = rawSources.map((s) => String(s));
    const rawNames = Array.isArray(map.names) ? map.names : undefined;
    const names = rawNames ? rawNames.map((n) => String(n)) : undefined;
    const mappingsText = typeof map.mappings === 'string' ? map.mappings : '';

    const iterator = new StringCharIterator(mappingsText);
    let sourceURL: string | undefined = sources[sourceIndex];

    for (;;) {
      if (iterator.peek() === ',') {
        iterator.next();
      } else {
        while (iterator.peek() === ';') {
          lineNumber += 1;
          columnNumber = 0;
          iterator.next();
        }
        if (!iterator.hasNext()) {
          break;
        }
      }

      columnNumber += decodeVLQ(iterator);
      if (!iterator.hasNext() || isSeparator(iterator.peek())) {
        this.#mappings.push([lineNumber, columnNumber]);
        continue;
      }

      const sourceIndexDelta = decodeVLQ(iterator);
      if (sourceIndexDelta) {
        sourceIndex += sourceIndexDelta;
        sourceURL = sources[sourceIndex];
      }
      sourceLineNumber += decodeVLQ(iterator);
      sourceColumnNumber += decodeVLQ(iterator);

      let name: string | undefined;
      if (iterator.hasNext() && !isSeparator(iterator.peek())) {
        nameIndex += decodeVLQ(iterator);
        name = names?.[nameIndex];
      }

      this.#mappings.push([
        lineNumber,
        columnNumber,
        sourceURL,
        sourceLineNumber,
        sourceColumnNumber,
        name,
      ]);
    }
  }

  findEntry(lineOffset: number, columnOffset: number): SourceMapEntry {
    let first = 0;
    let count = this.#mappings.length;
    while (count > 1) {
      const step = count >> 1;
      const middle = first + step;
      const mapping = this.#mappings[middle];
      if (lineOffset < mapping[0] || (lineOffset === mapping[0] && columnOffset < mapping[1])) {
        count = step;
      } else {
        first = middle;
        count -= step;
      }
    }
    const entry = this.#mappings[first];
    if (
      !first &&
      entry &&
      (lineOffset < entry[0] || (lineOffset === entry[0] && columnOffset < entry[1]))
    ) {
      return {};
    }
    if (!entry) {
      return {};
    }
    return {
      generatedLine: entry[0],
      generatedColumn: entry[1],
      originalSource: entry[2],
      originalLine: entry[3],
      originalColumn: entry[4],
      name: entry[5],
    };
  }

  findOrigin(lineNumber: number, columnNumber: number): SourceOrigin {
    const range = this.findEntry(lineNumber - 1, columnNumber - 1);
    if (
      range.originalSource === undefined ||
      range.originalLine === undefined ||
      range.originalColumn === undefined ||
      range.generatedLine === undefined ||
      range.generatedColumn === undefined
    ) {
      return {};
    }
    const lineOffset = lineNumber - range.generatedLine;
    const columnOffset = columnNumber - range.generatedColumn;
    return {
      name: range.name,
      fileName: range.originalSource,
      lineNumber: range.originalLine + lineOffset,
      columnNumber: range.originalColumn + columnOffset,
    };
  }
}
