import { record } from './protocol';
import { styleCodes } from './style-codes';

function invalid(name: string) {
  return Object.assign(new TypeError(`Invalid ${name}`), { code: 'ERR_INVALID_ARG_TYPE' });
}

export function createStyleText(
  defaultStream: () => unknown,
  environment: () => Record<string, unknown>,
) {
  return function styleText(
    format: unknown,
    text: unknown,
    options: { validateStream?: unknown; stream?: unknown } = {},
  ) {
    const { validateStream = true, stream = defaultStream() } = options;
    if (typeof text !== 'string') throw invalid('text');
    if (typeof validateStream !== 'boolean') throw invalid('options.validateStream');
    let colorize = true;
    if (validateStream) {
      if (
        !record(stream) ||
        !(
          (typeof stream.pipeThrough === 'function' &&
            typeof stream.getReader === 'function' &&
            typeof stream.cancel === 'function') ||
          (typeof stream.getWriter === 'function' && typeof stream.abort === 'function') ||
          stream._readableState ||
          stream._writableState ||
          (typeof stream.on === 'function' &&
            (typeof stream.write === 'function' || typeof stream.pipe === 'function'))
        )
      )
        throw invalid('stream');
      const force = environment().FORCE_COLOR;
      colorize =
        force !== undefined
          ? ['', '1', 'true', '2', '3'].includes(String(force))
          : !!stream.isTTY &&
            (typeof stream.getColorDepth !== 'function' || stream.getColorDepth() > 2);
    }
    let before = '';
    let after = '';
    for (const key of Array.isArray(format) ? format : [format]) {
      if (key === 'none') continue;
      if (typeof key !== 'string' || !Object.hasOwn(styleCodes, key))
        throw Object.assign(new TypeError('Invalid format'), { code: 'ERR_INVALID_ARG_VALUE' });
      const codes = styleCodes[key]!;
      if (colorize) {
        before += `\u001b[${codes[0]}m`;
        after = `\u001b[${codes[1]}m` + after;
      }
    }
    return before + text + after;
  };
}
