import path from 'path-browserify';

// The guest filesystem is POSIX, independent of the host operating system.
export function pathToFileURL(value: string, cwd = '/'): URL {
  if (typeof value !== 'string')
    throw Object.assign(new TypeError('Path must be a string'), { code: 'ERR_INVALID_ARG_TYPE' });
  const url = new URL('file:///');
  let filename = path.resolve(cwd, value);
  if (value.endsWith('/') && !filename.endsWith('/')) filename += '/';
  url.pathname = filename
    .replaceAll('%', '%25')
    .replaceAll('\\', '%5C')
    .replaceAll('\n', '%0A')
    .replaceAll('\r', '%0D')
    .replaceAll('\t', '%09');
  return url;
}

export function fileURLToPath(value: string | URL): string {
  if (typeof value !== 'string' && !(value instanceof URL))
    throw Object.assign(new TypeError('Expected a file URL'), { code: 'ERR_INVALID_ARG_TYPE' });
  const url = new URL(value);
  if (url.protocol !== 'file:')
    throw Object.assign(new TypeError('Expected file: URL'), { code: 'ERR_INVALID_URL_SCHEME' });
  // Node's WHATWG parser folds file://localhost/ to an empty host; Chromium keeps it.
  if (url.hostname && url.hostname !== 'localhost')
    throw Object.assign(new TypeError('File URL host must be empty or localhost'), {
      code: 'ERR_INVALID_FILE_URL_HOST',
    });
  if (/%2f/i.test(url.pathname))
    throw Object.assign(new TypeError('File URL must not include encoded slash'), {
      code: 'ERR_INVALID_FILE_URL_PATH',
    });
  return decodeURIComponent(url.pathname);
}
