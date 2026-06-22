import { describe, expect, test } from 'bun:test';
import { createMemoryFileSystem } from '../src/fs/index.js';
import { createPackageRegistry } from '../src/packages/index.js';

describe('package registry', () => {
  test('persists installed packages and import maps through the workspace fs', async () => {
    const fs = createMemoryFileSystem({ root: '/work' });
    const registry = createPackageRegistry({
      fs,
      resolver: {
        async resolve(spec) {
          return {
            name: spec.name,
            version: spec.version ?? '1.0.0',
            url: `https://cdn.example/${spec.name}@${spec.version ?? '1.0.0'}`,
          };
        },
      },
    });

    await registry.install({ name: 'lucide-react', version: '1.2.3' });

    expect(await registry.list()).toEqual({
      'lucide-react': {
        name: 'lucide-react',
        version: '1.2.3',
        url: 'https://cdn.example/lucide-react@1.2.3',
      },
    });
    expect(await registry.getImportMap()).toEqual({
      'lucide-react': 'https://cdn.example/lucide-react@1.2.3',
    });
  });
});
