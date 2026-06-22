export function normalizePath(input: string): string {
  const raw = input.trim();
  if (!raw) return '/';
  const absolute = raw.startsWith('/') ? raw : `/${raw}`;
  const parts: string[] = [];
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join('/'));
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') return '/';
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? '/' : normalized.slice(0, idx);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') return '/';
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function isPathInside(path: string, root: string): boolean {
  const p = normalizePath(path);
  const r = normalizePath(root);
  return p === r || p.startsWith(`${r}/`);
}

export function relativePath(fromRoot: string, path: string): string {
  const root = normalizePath(fromRoot);
  const value = normalizePath(path);
  if (!isPathInside(value, root)) {
    throw createFsError('EINVAL', `Path ${value} is outside ${root}`);
  }
  if (value === root) return '';
  return value.slice(root.length + 1);
}

export function createFsError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
