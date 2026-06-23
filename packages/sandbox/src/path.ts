export function normalizeSandboxPath(path: string): string {
  const value = path.trim();
  const absolute = value.startsWith('/') ? value : `/${value}`;
  const out: string[] = [];
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join('/')}`;
}

export function joinSandboxPath(base: string, path: string): string {
  if (path.startsWith('/')) return normalizeSandboxPath(path);
  return normalizeSandboxPath(`${base}/${path}`);
}

export function assertInsideSandbox(path: string, root: string): string {
  const normalized = normalizeSandboxPath(path);
  const normalizedRoot = normalizeSandboxPath(root);
  if (normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized;
  }
  throw new Error(`Path escapes sandbox root: ${path}`);
}

export function resolveSandboxPath(cwd: string, path: string): string {
  return path.startsWith('/') ? normalizeSandboxPath(path) : joinSandboxPath(cwd, path);
}

export function dirname(path: string): string {
  const normalized = normalizeSandboxPath(path);
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return '/';
  return normalized.slice(0, index);
}
