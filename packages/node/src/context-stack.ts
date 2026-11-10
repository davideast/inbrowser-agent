// Experimental async context executes compiled code, so the positions the engine
// reports are positions in compiler output. This module keeps the compiler's
// source maps for scripts the loader owns and rewrites stack frames back to the
// positions in the source the guest wrote.

export interface Position {
  line: number;
  column: number;
}

/** Why a compiled script's positions differ from its file's. */
export interface ScriptOrigin {
  /** Lines the loader's wrapper puts before the source (the CommonJS function header). */
  lineOffset: number;
  /** Columns the loader inserts at the start of the first line (the module prologue). */
  firstLineShift: number;
  /**
   * Text the runtime inserted into compiler output, by zero-based generated line:
   * flat `column, length` pairs, ascending, with columns in the compiler's output
   * before any insertion. No insertion contains a line break.
   */
  insertions?: ReadonlyMap<number, readonly number[]>;
}

/**
 * The compiler-output column (one-based) for a one-based column in the text
 * after `pairs` were inserted. A column inside inserted text is the column the
 * text was inserted at.
 */
function removeInsertions(pairs: readonly number[], column: number): number {
  const index = column - 1;
  let shift = 0;
  for (let pair = 0; pair < pairs.length; pair += 2) {
    const start = pairs[pair] + shift;
    if (index < start) break;
    if (index < start + pairs[pair + 1]) return pairs[pair] + 1;
    shift += pairs[pair + 1];
  }
  return index - shift + 1;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MAP_COMMENT = '//# sourceMappingURL=data:application/json;base64,';

/**
 * Decodes a version 3 `mappings` string for a single-source map into one flat
 * array per generated line: generated column, original line, original column
 * (all zero-based), repeated. Segments without a source position are skipped.
 */
export function decodeMappings(mappings: string): number[][] {
  const lines: number[][] = [];
  let line: number[] = [];
  let generatedColumn = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let fields: number[] = [];
  let value = 0;
  let shift = 0;
  const flush = () => {
    if (fields.length === 0) return;
    generatedColumn += fields[0];
    if (fields.length >= 4) {
      originalLine += fields[2];
      originalColumn += fields[3];
      line.push(generatedColumn, originalLine, originalColumn);
    }
    fields = [];
  };
  for (const character of mappings) {
    if (character === ',' || character === ';') {
      flush();
      if (character === ';') {
        lines.push(line);
        line = [];
        generatedColumn = 0;
      }
      continue;
    }
    const digit = BASE64.indexOf(character);
    if (digit < 0) throw new Error('Invalid source map');
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    fields.push(value & 1 ? -(value >> 1) : value >> 1);
    value = shift = 0;
  }
  flush();
  lines.push(line);
  return lines;
}

/**
 * The scripts whose frames can be mapped. `limit` bounds the retained source-map
 * text plus script names; a script that does not fit is simply not registered and
 * its frames keep the positions the engine reported.
 */
export function createScriptMaps(limit: number) {
  type Script = ScriptOrigin & { encoded?: string; lines?: number[][] };
  const scripts = new Map<string, Script>();
  let retained = 0;
  return {
    /** Registers `name` as the engine will report it. `compiled` carries the inline map, if any. */
    register(name: string, compiled: string, origin: ScriptOrigin): void {
      const comment = compiled.lastIndexOf(MAP_COMMENT);
      const encoded =
        comment < 0 ? undefined : compiled.slice(comment + MAP_COMMENT.length).split('\n', 1)[0];
      const previous = scripts.get(name);
      if (previous) retained -= name.length + (previous.encoded?.length ?? 0);
      scripts.delete(name);
      const size = name.length + (encoded?.length ?? 0);
      if (retained + size > limit) return;
      retained += size;
      scripts.set(name, { ...origin, encoded });
    },
    /**
     * The original position for an engine-reported one (both one-based).
     * `undefined`: the script is not registered. `'generated'`: the position is
     * in code the compiler added and has no source.
     */
    locate(name: string, line: number, column: number): Position | 'generated' | undefined {
      const script = scripts.get(name);
      if (!script) return undefined;
      const generatedLine = line - 1 - script.lineOffset;
      const inserted = script.insertions?.get(generatedLine);
      if (inserted) column = removeInsertions(inserted, column);
      let position: Position;
      if (script.encoded === undefined) position = { line: generatedLine + 1, column };
      else {
        if (!script.lines) {
          const map: unknown = JSON.parse(atob(script.encoded));
          const mappings =
            typeof map === 'object' && map !== null && 'mappings' in map ? map.mappings : '';
          script.lines = decodeMappings(typeof mappings === 'string' ? mappings : '');
        }
        const segments = script.lines[generatedLine];
        let found = -1;
        if (segments)
          for (let index = 0; index < segments.length && segments[index] <= column - 1; index += 3)
            found = index;
        if (found < 0) return 'generated';
        position = { line: segments[found + 1] + 1, column: segments[found + 2] + 1 };
      }
      if (position.line === 1)
        position.column = Math.max(1, position.column - script.firstLineShift);
      return position;
    },
  };
}

/** The V8 call-site methods this module reads. */
interface CallSite {
  getScriptNameOrSourceURL?(): unknown;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
}

/**
 * Formats a stack the way the engine does, with frames in registered scripts
 * rewritten to original positions and compiler helper frames left out.
 */
export function formatStack(
  error: unknown,
  sites: readonly CallSite[],
  locate: (name: string, line: number, column: number) => Position | 'generated' | undefined,
): string {
  let text: string;
  try {
    // The engine's own header is Error.prototype.toString applied to any object.
    text = Error.prototype.toString.call(error);
  } catch {
    text = '<error>';
  }
  for (const site of sites) {
    let frame = String(site);
    const name = site.getScriptNameOrSourceURL?.();
    const line = site.getLineNumber();
    const column = site.getColumnNumber();
    if (typeof name === 'string' && name && line !== null && column !== null) {
      const original = locate(name, line, column);
      if (original === 'generated') continue;
      if (original) {
        const reported = `${name}:${line}:${column}`;
        const at = frame.lastIndexOf(reported);
        if (at >= 0)
          frame =
            frame.slice(0, at) +
            `${name}:${original.line}:${original.column}` +
            frame.slice(at + reported.length);
      }
    }
    text += '\n    at ' + frame;
  }
  return text;
}
