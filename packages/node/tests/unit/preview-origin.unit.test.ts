import { describe, expect, it } from 'vitest';
import { parsePreviewOptions, previewOriginFor } from '../../src/preview-origin';

const HOST = 'http://127.0.0.1:4421';
const ID = '6f1c1f7e-2b7a-4f4e-9a55-0d2f1b6c9e10';

function caught(run: () => unknown): (Error & { code?: string }) | undefined {
  try {
    run();
  } catch (error) {
    return error as Error & { code?: string };
  }
  return undefined;
}

describe('parsePreviewOptions', () => {
  it('returns undefined when the option is absent', () => {
    expect(parsePreviewOptions(undefined, HOST)).toBeUndefined();
  });

  it('accepts a template on *.localhost and on https, with or without a trailing slash', () => {
    expect(
      parsePreviewOptions({ origin: 'http://{container}-{port}.localhost:6421' }, HOST),
    ).toEqual({
      origin: 'http://{container}-{port}.localhost:6421',
      embedderPolicy: 'require-corp',
    });
    expect(
      parsePreviewOptions(
        {
          origin: 'https://{container}-{port}.preview.example.com/',
          embedderPolicy: 'require-corp',
        },
        HOST,
      ),
    ).toEqual({
      origin: 'https://{container}-{port}.preview.example.com/',
      embedderPolicy: 'require-corp',
    });
    expect(
      parsePreviewOptions({ origin: 'https://p{port}.{container}.example.com' }, HOST)?.origin,
    ).toBe('https://p{port}.{container}.example.com');
  });

  it('rejects a bad shape with TypeError / ERR_INVALID_ARG_TYPE', () => {
    for (const value of [null, 'http://{container}-{port}.localhost', [], 7]) {
      const error = caught(() => parsePreviewOptions(value, HOST));
      expect(error).toBeInstanceOf(TypeError);
      expect(error?.code).toBe('ERR_INVALID_ARG_TYPE');
    }
    for (const value of [{}, { origin: 42 }, { origin: null }, { origin: 'x', extra: 1 }]) {
      const error = caught(() => parsePreviewOptions(value, HOST));
      expect(error).toBeInstanceOf(TypeError);
      expect(error?.code).toBe('ERR_INVALID_ARG_TYPE');
    }
    const policy = caught(() =>
      parsePreviewOptions(
        { origin: 'http://{container}-{port}.localhost', embedderPolicy: 1 },
        HOST,
      ),
    );
    expect(policy).toBeInstanceOf(TypeError);
    expect(policy?.code).toBe('ERR_INVALID_ARG_TYPE');
  });

  it('rejects every malformed or unsafe template with EINVAL', () => {
    const cases = [
      // a placeholder is missing
      'http://{container}.localhost:6421',
      'http://{port}.localhost:6421',
      'http://preview.localhost:6421',
      // not an absolute URL, or not http(s)
      '{container}-{port}.localhost',
      '/__preview__/{container}/{port}',
      'ftp://{container}-{port}.localhost',
      'data:{container}{port}',
      // not an origin: a path, query, fragment or credentials
      'http://{container}-{port}.localhost:6421/app/',
      'http://{container}-{port}.localhost:6421/?x=1',
      'http://{container}-{port}.localhost:6421/#x',
      'http://user@{container}-{port}.localhost:6421',
      // placeholders that do not select the origin, so previews would share one
      'http://127.0.0.1:4421/{container}/{port}',
      'http://preview.localhost:6421/{container}/{port}',
      // an unknown placeholder left behind
      'http://{container}-{port}-{name}.localhost:6421',
      // not potentially trustworthy, so it cannot register a service worker
      'http://{container}-{port}.preview.example.com',
    ];
    for (const origin of cases) {
      const error = caught(() => parsePreviewOptions({ origin }, HOST));
      expect({ origin, code: error?.code }).toEqual({ origin, code: 'EINVAL' });
    }
    const unsupported = caught(() =>
      parsePreviewOptions(
        { origin: 'http://{container}-{port}.localhost', embedderPolicy: 'credentialless' },
        HOST,
      ),
    );
    expect(unsupported?.code).toBe('EINVAL');
  });

  it('rejects a template that names the host origin', () => {
    const error = caught(() =>
      parsePreviewOptions({ origin: 'http://127.0.0.1:4421/{container}{port}' }, HOST),
    );
    expect(error?.code).toBe('EINVAL');
  });
});

describe('previewOriginFor', () => {
  it('substitutes every placeholder and returns the origin without a trailing slash', () => {
    expect(previewOriginFor('http://{container}-{port}.localhost:6421', ID, 3000)).toBe(
      `http://${ID}-3000.localhost:6421`,
    );
    expect(previewOriginFor('https://{container}-{port}.preview.example.com/', ID, 8080)).toBe(
      `https://${ID}-8080.preview.example.com`,
    );
  });

  it('gives distinct origins for distinct containers and ports', () => {
    const template = 'http://{container}-{port}.localhost:6421';
    const other = '0b8f0b55-8f39-4a59-8f06-7a1bb7d1f2a3';
    const origins = new Set([
      previewOriginFor(template, ID, 3000),
      previewOriginFor(template, ID, 3001),
      previewOriginFor(template, other, 3000),
    ]);
    expect(origins.size).toBe(3);
  });
});
