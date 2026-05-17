/**
 * `agent schema` — emit the full CliSpec as JSON. Stable contract for
 * agent integrations: introspect once, cache the schema, and drive
 * the CLI without reading `--help` text.
 */

import type { Emitter } from '../output.js';
import { CLI_SPEC } from '../spec.js';

export function schemaCommand(emit: Emitter): number {
  emit.event({ type: 'schema', ...CLI_SPEC }, () => JSON.stringify(CLI_SPEC, null, 2));
  emit.finish();
  return 0;
}
