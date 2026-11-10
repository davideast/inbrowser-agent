import { fault } from './protocol';

export function assetLocation(value: unknown, defaultURL: string): URL {
  if (value !== undefined && typeof value !== 'string')
    throw fault('EINVAL', 'assetBaseURL must be a URL string');
  let url: URL;
  try {
    url = new URL(value === undefined ? defaultURL : value, location.href);
  } catch {
    throw fault('EINVAL', 'Invalid assetBaseURL');
  }
  if (
    url.origin !== location.origin ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('/')
  )
    throw fault('EINVAL', 'assetBaseURL must be a same-origin directory URL');
  return url;
}
