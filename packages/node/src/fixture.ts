import { fault, record } from './protocol';
/** Load trusted build output and verify each file before mounting. Not a package installer. */
export async function loadFixture(
  url: string,
  signal?: AbortSignal,
): Promise<Record<string, Uint8Array>> {
  signal?.throwIfAborted();
  const response = await fetch(url, { signal });
  if (!response.ok) throw fault('EIO', `Fixture fetch failed: ${response.status}`);
  const fixture: unknown = await response.json();
  if (!record(fixture) || !record(fixture.files)) throw fault('EINVAL', 'Invalid fixture');
  const files: Record<string, Uint8Array> = {};
  await Promise.all(
    Object.entries(fixture.files).map(async ([path, file]) => {
      if (!record(file) || typeof file.base64 !== 'string' || typeof file.sha256 !== 'string')
        throw fault('EINVAL', 'Invalid fixture file');
      const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      if (hash !== file.sha256) throw fault('EINTEGRITY', `Fixture hash mismatch: ${path}`);
      files[path] = bytes;
    }),
  );
  signal?.throwIfAborted();
  return files;
}
