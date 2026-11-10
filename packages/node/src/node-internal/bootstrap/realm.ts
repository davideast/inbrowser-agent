// Browser-safe `internal/bootstrap/realm` shim exposing `BuiltinModule.exists`.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { builtinModules } from '../../builtin-modules';

const knownBuiltins = new Set<string>(builtinModules);

export const BuiltinModule = {
  exists(id: string): boolean {
    if (id.startsWith('internal/')) return true;
    const stripped = id.startsWith('node:') ? id.slice(5) : id;
    return knownBuiltins.has(stripped);
  },
};
