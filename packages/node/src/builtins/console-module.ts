import { upgradeGlobalConsole } from '../console';

export interface ConsoleBuiltinDeps<TConsole extends Record<string, unknown>> {
  guestConsole: TConsole;
  process: {
    stdout: {
      write: (chunk: string) => boolean;
      isTTY?: boolean;
      columns?: number;
      rows?: number;
    };
    stderr: {
      write: (chunk: string) => boolean;
      isTTY?: boolean;
      columns?: number;
      rows?: number;
    };
    env: Record<string, unknown>;
    hrtime?: (time?: [number, number]) => [number, number];
    emitWarning?: (warning: string | Error, type?: string, code?: string) => void;
  };
}

export function createConsoleBuiltin<TConsole extends Record<string, unknown>>({
  guestConsole,
  process,
}: ConsoleBuiltinDeps<TConsole>): TConsole {
  return upgradeGlobalConsole(guestConsole, process);
}
