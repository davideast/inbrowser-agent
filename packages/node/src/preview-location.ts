// Keeps a guest's root-relative `Location` inside the preview prefix.
//
// A guest that answers `302 Location: /login` means "/login on my server". In
// prefix mode the browser resolves that against the host origin and leaves the
// preview. The service worker calls this once for every response head it hands
// to the browser (streamed or not, in either `requestPath` mode), so the rule
// lives in one place. It is pure: no DOM, Worker or memfs, and it never throws.
//
// Rules, for any status that carries one `Location`:
//   - `/path?query#fragment` (one leading slash) becomes `<prefix>/path?query#fragment`.
//   - Already inside the prefix (`<prefix>`, `<prefix>/...`, `<prefix>?...`,
//     `<prefix>#...`): unchanged, so a preserve-mode app that knows its base is
//     never double-prefixed. A root-relative value without the prefix is
//     rewritten in preserve mode too: it could only reach the host's own path.
//   - `//host/x`, `/\host/x` (browsers read a backslash as a slash), absolute URLs,
//     relative paths, query-only and fragment-only values, and values holding
//     tab, CR or LF (which URL parsers strip) are unchanged. Absolute URLs are
//     unchanged even when they name the guest's own virtual origin: the runtime
//     gives the guest no Host, so there is no authority to match exactly.
//   - Zero or several `Location` headers, or a non-string value: unchanged.
// `Set-Cookie` and every other header are untouched.

/** The prefix without its trailing slash, formed as `container.preview()` forms it. */
export function previewPrefix(containerId: string, port: number): string {
  return `/__preview__/${containerId}/${port}`;
}

/** Rewrites one `Location` value; returns the input when no rule applies. */
export function rewriteLocationValue(value: unknown, prefix: string): unknown {
  if (typeof value !== 'string') return value;
  if (value[0] !== '/' || value[1] === '/' || value[1] === '\\') return value;
  if (/[\t\r\n]/.test(value)) return value;
  if (value.startsWith(prefix)) {
    const next = value[prefix.length];
    if (next === undefined || next === '/' || next === '?' || next === '#') return value;
  }
  return prefix + value;
}

/** Returns `headers` itself when nothing changes, otherwise a copy. */
export function rewritePreviewLocation<T extends Record<string, unknown>>(
  headers: T,
  containerId: string,
  port: number,
): T {
  try {
    const keys = Object.keys(headers).filter((key) => key.toLowerCase() === 'location');
    if (keys.length !== 1) return headers;
    const key = keys[0];
    const value = headers[key];
    const prefix = previewPrefix(containerId, port);
    let next: unknown = value;
    if (Array.isArray(value)) {
      if (value.length !== 1) return headers;
      const item = rewriteLocationValue(value[0], prefix);
      if (item !== value[0]) next = [item];
    } else next = rewriteLocationValue(value, prefix);
    return next === value ? headers : { ...headers, [key]: next };
  } catch {
    return headers;
  }
}
