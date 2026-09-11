import { mock } from 'bun:test';
import { resolve } from 'node:path';
const from = process.env.PYRIC_LOCAL_MODULES
  ? resolve(process.env.PYRIC_LOCAL_MODULES, '..')
  : import.meta.dir;
// Replace the external SDK boundary with the real Pyric implementation. No
// bridge methods, Rules evaluator, storage, or auth behavior are mocked.
for (const subpath of ['sandbox', 'sandbox/database', 'app/internal', 'app', 'auth', 'database']) {
  const implementation = await import(Bun.resolveSync(`pyric/${subpath}`, from));
  mock.module(`pyric/${subpath}`, () => implementation);
  if (['app', 'auth', 'database'].includes(subpath))
    mock.module(`firebase/${subpath}`, () => implementation);
}
process.env.INBROWSER_PYRIC_TEST = '1';
