// Browser-safe `internal/tty` `getColorDepth` implementation matching Node.js v22.18.0.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { activeProcess } from './process-ref';

const COLORS_2 = 1;
const COLORS_16 = 4;
const COLORS_256 = 8;
const COLORS_16m = 24;

export function getColorDepth(env: Record<string, unknown> = activeProcess().env): number {
  if (env.FORCE_COLOR !== undefined) {
    switch (env.FORCE_COLOR) {
      case '':
      case '1':
      case 'true':
        return COLORS_16;
      case '2':
        return COLORS_256;
      case '3':
        return COLORS_16m;
      default:
        return COLORS_2;
    }
  }

  if (
    (env.NO_COLOR !== undefined && env.NO_COLOR !== '') ||
    env.NODE_DISABLE_COLORS !== undefined ||
    env.TERM === 'dumb'
  ) {
    return COLORS_2;
  }

  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') {
    return COLORS_16m;
  }

  if (typeof env.TERM === 'string' && /-256(color)?$/i.test(env.TERM)) {
    return COLORS_256;
  }

  return COLORS_16;
}
