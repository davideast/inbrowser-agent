import { fault, record } from './protocol';

export type HttpHeaderPolicy = Readonly<Record<string, readonly string[]>>;

export function validateHttpHeaderPolicy(value: unknown): HttpHeaderPolicy {
  if (value === undefined) return {};
  if (!record(value) || Object.keys(value).length > 64)
    throw fault('EINVAL', 'Invalid HTTP header policy');
  const result: Record<string, readonly string[]> = Object.create(null);
  for (const [origin, names] of Object.entries(value)) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw fault('EINVAL', 'Invalid HTTP policy origin');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      result[url.origin]
    )
      throw fault('EINVAL', 'HTTP policy requires distinct HTTP origins');
    if (
      !Array.isArray(names) ||
      names.length > 64 ||
      !names.every(
        (name) =>
          typeof name === 'string' && name.length <= 256 && /^[!#$%&'*+.^_`|~\w-]+$/.test(name),
      )
    )
      throw fault('EINVAL', 'Invalid omitted header names');
    result[url.origin] = Object.freeze(names.map((name) => name.toLowerCase()));
  }
  return Object.freeze(result);
}
