import { fault } from './protocol';

// The per-origin preview template (`BootOptions.preview`, design §7.1 and
// decision 3). Pure: no DOM, Worker or memfs, so the Node unit tier covers it.
//
// A template is an origin with `{container}` and `{port}` placeholders, for
// example `https://{container}-{port}.preview.example.com`. It is accepted only
// when every substitution gives a distinct, potentially trustworthy http(s)
// origin that is not the host's own: the preview worker needs a secure context,
// and previews that shared an origin would share one worker and one bridge.

export interface PreviewOriginOptions {
  /** Origin template with `{container}` and `{port}`. */
  origin: string;
  /** Embedder policy on preview responses. Only 'require-corp' (decision 6). */
  embedderPolicy: 'require-corp';
}

const SAMPLE_IDS = ['00000000-0000-4000-8000-000000000000', 'ffffffff-ffff-4fff-bfff-ffffffffffff'];
const SAMPLE_PORTS = [1, 65535];

function invalidType(path: string, expected: string, value: unknown): TypeError {
  const actual =
    value === null
      ? 'null'
      : Array.isArray(value)
        ? 'Array'
        : typeof value === 'object'
          ? 'Object'
          : typeof value;
  return Object.assign(
    new TypeError(`The "${path}" argument must be ${expected}. Received type ${actual}`),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
}

function trustworthy(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  const host = url.hostname;
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === '[::1]'
  );
}

/** Substitutes both placeholders; returns the URL or undefined when it is not one. */
function substitute(template: string, containerId: string, port: number): URL | undefined {
  const value = template.replaceAll('{container}', containerId).replaceAll('{port}', String(port));
  if (/[{}]/.test(value)) return;
  try {
    return new URL(value);
  } catch {
    return;
  }
}

/**
 * Validates `BootOptions.preview`. A wrong shape is `TypeError` /
 * `ERR_INVALID_ARG_TYPE`; a template that is not a usable preview origin is
 * `EINVAL`. Runs before any Worker or service-worker registration exists.
 */
export function parsePreviewOptions(
  value: unknown,
  hostOrigin: string,
): PreviewOriginOptions | undefined {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalidType('preview', 'an object', value);
  for (const key of Object.keys(value))
    if (key !== 'origin' && key !== 'embedderPolicy')
      throw Object.assign(
        new TypeError(`Unknown preview option "${key}"; expected origin or embedderPolicy`),
        { code: 'ERR_INVALID_ARG_TYPE' },
      );
  // Checked to be a non-array object above; each field is checked below.
  const options = value as Record<string, unknown>;
  const template = options.origin;
  if (typeof template !== 'string') throw invalidType('preview.origin', 'a string', template);
  const policy = options.embedderPolicy;
  if (policy !== undefined && typeof policy !== 'string')
    throw invalidType('preview.embedderPolicy', 'a string', policy);
  if (policy !== undefined && policy !== 'require-corp')
    throw fault('EINVAL', "preview.embedderPolicy must be 'require-corp'");
  if (!template.includes('{container}') || !template.includes('{port}'))
    throw fault('EINVAL', 'preview.origin must contain {container} and {port}');
  const origins = new Set<string>();
  for (const id of SAMPLE_IDS)
    for (const port of SAMPLE_PORTS) {
      const url = substitute(template, id, port);
      if (
        !url ||
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.username ||
        url.password ||
        url.href !== url.origin + '/'
      )
        throw fault('EINVAL', 'preview.origin must be an absolute http(s) origin template');
      if (url.origin === hostOrigin)
        throw fault('EINVAL', 'preview.origin must not be the host origin');
      if (!trustworthy(url))
        throw fault('EINVAL', 'preview.origin must be https or a localhost origin');
      origins.add(url.origin);
    }
  if (origins.size !== SAMPLE_IDS.length * SAMPLE_PORTS.length)
    throw fault('EINVAL', 'preview.origin must give each container and port its own origin');
  return { origin: template, embedderPolicy: 'require-corp' };
}

/** The origin (no trailing slash) serving one container's port. */
export function previewOriginFor(template: string, containerId: string, port: number): string {
  const url = substitute(template, containerId, port);
  if (!url) throw fault('EINVAL', 'Invalid preview origin');
  return url.origin;
}
