// Browser-safe `internal/util/colors` matching Node.js v22.18.0, staying synced
// with the active guest `process` (`stderr` TTY / `FORCE_COLOR` / `NO_COLOR`).
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { activeProcess, onGuestProcessChange } from '../process-ref';
import { getColorDepth } from '../tty';

interface ColorStream {
  isTTY?: boolean;
  getColorDepth?: () => number;
}

export let blue = '';
export let green = '';
export let white = '';
export let yellow = '';
export let red = '';
export let gray = '';
export let clear = '';
export let reset = '';
export let hasColors = false;

export function shouldColorize(stream?: ColorStream): boolean {
  const proc = activeProcess();
  if (proc.env?.FORCE_COLOR !== undefined) {
    return getColorDepth(proc.env) > 2;
  }
  if (stream?.isTTY) {
    return typeof stream.getColorDepth === 'function'
      ? stream.getColorDepth() > 2
      : getColorDepth(proc.env) > 2;
  }
  return false;
}

export function refresh(): void {
  const proc = activeProcess();
  if (shouldColorize(proc.stderr)) {
    blue = '\u001b[34m';
    green = '\u001b[32m';
    white = '\u001b[39m';
    yellow = '\u001b[33m';
    red = '\u001b[31m';
    gray = '\u001b[90m';
    clear = '\u001bc';
    reset = '\u001b[0m';
    hasColors = true;
  } else {
    blue = '';
    green = '';
    white = '';
    yellow = '';
    red = '';
    gray = '';
    clear = '';
    reset = '';
    hasColors = false;
  }
}

onGuestProcessChange(() => {
  refresh();
});

refresh();
