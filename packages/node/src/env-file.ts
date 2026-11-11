// The `.env` parser behind process.loadEnvFile, after Node 22.18's
// Dotenv::ParseContent (src/node_dotenv.cc). Its quirks are kept because they are
// observable: trimming crosses newlines, so `KEY=   ` followed by a line takes
// that line as its value; the rest of a line after a quoted value is skipped
// without trimming, so an indented `# x=y` after it is read as a key; unquoted
// values end at `#`; only double-quoted values expand `\n`.

const SPACE = ' \n\t';

function trim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && SPACE.includes(value[start])) start++;
  while (end > start && SPACE.includes(value[end - 1])) end--;
  return value.slice(start, end);
}

/** The text after the next newline at or after `from`, or undefined when there is none. */
function afterLine(content: string, from = 0): string | undefined {
  const newline = content.indexOf('\n', from);
  return newline === -1 ? undefined : content.slice(newline + 1);
}

/** The variables a `.env` text defines, in order; a later duplicate wins. */
export function parseEnv(input: string): Map<string, string> {
  const store = new Map<string, string>();
  let content = trim(input.replace(/\r/g, ''));
  while (content !== '') {
    // Empty lines and comments.
    if (content[0] === '\n' || content[0] === '#') {
      content = afterLine(content) ?? '';
      continue;
    }
    const equalOrNewline = content.search(/[=\n]/);
    // No `=` before the end of the line: not a variable.
    if (equalOrNewline === -1 || content[equalOrNewline] === '\n') {
      const rest = afterLine(content);
      if (rest === undefined) break;
      content = trim(rest);
      continue;
    }
    let key = trim(content.slice(0, equalOrNewline));
    content = content.slice(equalOrNewline + 1);
    if (key === '') {
      const rest = afterLine(content);
      if (rest === undefined) break;
      content = trim(rest);
      continue;
    }
    if (key.startsWith('export ')) key = trim(key.slice(7));
    if (content === '' || content[0] === '\n') {
      store.set(key, '');
      continue;
    }
    content = trim(content);
    const quote = content[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      const closing = content.indexOf(quote, 1);
      if (closing !== -1) {
        const value = content.slice(1, closing);
        store.set(key, quote === '"' ? value.replace(/\\n/g, '\n') : value);
        content = afterLine(content, closing + 1) ?? '';
        continue;
      }
    }
    // Unquoted, or a quote that is never closed.
    const newline = content.indexOf('\n');
    let value = newline === -1 ? content : content.slice(0, newline);
    const hash = value.indexOf('#');
    if (hash !== -1) value = value.slice(0, hash);
    store.set(key, trim(value));
    content = newline === -1 ? '' : trim(content.slice(newline + 1));
  }
  return store;
}
